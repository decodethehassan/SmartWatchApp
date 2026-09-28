/** Stage 2 app-side raw cloud backup.
 * - Bounded 4 MiB temporary upload chunks; never create a huge JS Blob.
 * - Firebase Storage resumable REST session with native Expo file uploads.
 * - Every completed cloud object is checked with Firebase Storage getMetadata.
 * - Overlapping NAND snapshots are identified with exact prefix SHA-256 hashes.
 * - Older cloud snapshots are NEVER automatically erased.
 *
 * IMPORTANT: Test on an EAS preview Android build before treating uploads as production-verified.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { getMetadata, ref } from 'firebase/storage';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, storage } from './firebaseConfig';
import { getRawRecordings, saveRawRecordingMetadata } from './dataLogger';
import type { RawRecordingMetadata } from './sensorTypes';
import { inspectBin, type BinInspection } from '../functionality/binInspectionService';
import { importBinMinuteHistory } from './binHistoryService';

// Expo SDK 54's legacy file-system implementation is loaded at runtime through
// a static Metro require. Avoid importing its TS sources directly: the SDK's
// ExponentFileSystemShim currently exposes three implicit-any fields under the
// app's strict TypeScript settings. Keep the native upload API narrowly typed.
type NativeUploadProgress = {
  totalBytesSent: number;
  totalBytesExpectedToSend: number;
};
type NativeUploadResult = { status: number };
type NativeUploadTask = {
  uploadAsync(): Promise<NativeUploadResult | undefined>;
};
type NativeLegacyFileSystem = {
  FileSystemUploadType: { BINARY_CONTENT: number };
  createUploadTask(
    url: string,
    fileUri: string,
    options: {
      httpMethod: 'POST';
      uploadType: number;
      headers: Record<string, string>;
    },
    onProgress?: (progress: NativeUploadProgress) => void,
  ): NativeUploadTask;
};
declare const require: (moduleName: string) => unknown;
const { createUploadTask, FileSystemUploadType } =
  require('expo-file-system/legacy') as NativeLegacyFileSystem;


const BUCKET='audiostimulator-mhtech.firebasestorage.app';
const CHUNK_SIZE=4*1024*1024; // 256 KiB aligned; <= 4 MiB phone RAM per upload chunk.
const SESSION_PREFIX='audiostim_raw_upload_session_v2:';
const LAST_LOCAL_PREFIX='audiostim_raw_local_v2:';
export type CloudPhase='idle'|'indexing'|'importing'|'uploading'|'verifying'|'complete'|'error';
export interface CloudBackupState {
  phase:CloudPhase;
  fileUri:string|null;
  fileName:string|null;
  sentBytes:number;
  totalBytes:number;
  progress:number;
  message:string;
  error:string|null;
  deduplicated:boolean;
  overlapCount:number;
  indexedMinuteCount:number;
  undatedMinuteCount:number;
}
export interface RawLocalCandidate {uid:string;deviceId:string;deviceName?:string;fileUri:string;fileName:string;}
interface UploadSession {url:string;storagePath:string;size:number;createdMs:number;}
const initial:CloudBackupState={phase:'idle',fileUri:null,fileName:null,sentBytes:0,totalBytes:0,progress:0,
  message:'Cloud backup has not started',error:null,deduplicated:false,overlapCount:0,indexedMinuteCount:0,undatedMinuteCount:0};
const safePart=(s:string)=>s.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,85);
const objectName=(uid:string,deviceId:string,sha:string)=>`raw-data/${uid}/${safePart(deviceId)}/${sha}.bin`;
const sessionKey=(uid:string,sha:string)=>`${SESSION_PREFIX}${uid}:${sha}`;
const lastKey=(uid:string)=>`${LAST_LOCAL_PREFIX}${uid}`;
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const isObjectMissing=(err:unknown)=>String((err as any)?.code||'').includes('object-not-found');

async function currentToken(uid:string):Promise<string>{
  const user=auth.currentUser;
  if(!user||user.uid!==uid) throw new Error('Sign in with the same account used for raw sync.');
  return user.getIdToken();
}
async function remoteSize(path:string):Promise<{size:number;generation?:string;md5Hash?:string}|null>{
  try {
    const m=await getMetadata(ref(storage,path));
    return {size:Number(m.size),generation:(m as any).generation,md5Hash:m.md5Hash};
  }catch(e){if(isObjectMissing(e))return null;throw e;}
}
const header=(res:Response,name:string)=>res.headers.get(name)||res.headers.get(name.toLowerCase());
async function startSession(uid:string,path:string,size:number):Promise<UploadSession>{
  const token=await currentToken(uid);
  const endpoint=`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`;
  const res=await fetch(endpoint,{
    method:'POST',
    headers:{
      'Authorization':`Firebase ${token}`,
      'Content-Type':'application/json; charset=UTF-8',
      'X-Goog-Upload-Protocol':'resumable',
      'X-Goog-Upload-Command':'start',
      'X-Goog-Upload-Header-Content-Type':'application/octet-stream',
      'X-Goog-Upload-Header-Content-Length':String(size),
    },
    body:JSON.stringify({name:path,contentType:'application/octet-stream'}),
  });
  if(!res.ok) throw new Error(`Firebase Storage could not start upload: HTTP ${res.status} ${((await res.text()).slice(0,160))}`);
  const url=header(res,'X-Goog-Upload-URL');
  if(!url||!url.startsWith('https://'))throw new Error('Storage did not return a resumable upload URL.');
  return {url,storagePath:path,size,createdMs:Date.now()};
}
async function queryOffset(uid:string,s:UploadSession):Promise<number>{
  const token=await currentToken(uid);
  const res=await fetch(s.url,{method:'POST',headers:{
    'Authorization':`Firebase ${token}`,'X-Goog-Upload-Command':'query',
    'X-Goog-Upload-Protocol':'resumable',
  }});
  if(!res.ok && res.status!==308)throw new Error(`Upload session query returned HTTP ${res.status}.`);
  const size=Number(header(res,'X-Goog-Upload-Size-Received')||'0');
  if(!Number.isSafeInteger(size)||size<0||size>s.size)throw new Error('Storage returned an invalid resume offset.');
  return size;
}

class RawCloudBackupService {
  private state:CloudBackupState={...initial};
  private listeners=new Set<(s:CloudBackupState)=>void>();
  private active=false;
  private cancelRequested=false;
  getState():CloudBackupState{return {...this.state};}
  subscribe(fn:(s:CloudBackupState)=>void):()=>void{
    this.listeners.add(fn);fn(this.getState());return ()=>this.listeners.delete(fn);
  }
  private publish(p:Partial<CloudBackupState>):void{
    this.state={...this.state,...p};
    for(const fn of this.listeners)try{fn(this.getState());}catch(e){console.warn('[RawCloud]',e);}
  }
  async remember(candidate:RawLocalCandidate):Promise<void>{
    // Local file:// URI is stored only on this phone, never uploaded to Firestore.
    await AsyncStorage.setItem(lastKey(candidate.uid),JSON.stringify(candidate));
  }
  async lastLocal(uid:string):Promise<RawLocalCandidate|null>{
    const raw=await AsyncStorage.getItem(lastKey(uid));
    if(!raw)return null;
    try{
      const c=JSON.parse(raw) as RawLocalCandidate;
      return c.uid===uid&&new File(c.fileUri).exists?c:null;
    }catch{return null;}
  }
  cancelAfterChunk():void{
    this.cancelRequested=true;
    if(this.active)this.publish({message:'Finishing current chunk, then pausing backup…'});
  }
  async backup(candidate:RawLocalCandidate):Promise<void>{
    if(this.active)return;
    if(this.state.fileUri===candidate.fileUri && this.state.phase==='complete' &&
      this.state.totalBytes>0 && new File(candidate.fileUri).exists &&
      Number(new File(candidate.fileUri).size)===this.state.totalBytes) return;
    if(!candidate.uid||!candidate.deviceId){
      this.publish({phase:'error',error:'A signed-in user and stable wristband ID are required.',message:'Cannot identify raw data owner'});
      return;
    }
    this.active=true;this.cancelRequested=false;
    let pendingMetadata:RawRecordingMetadata|null=null;
    let archiveVerified=false;
    let historyFailure:string|null=null;
    this.publish({...initial,phase:'indexing',fileUri:candidate.fileUri,fileName:candidate.fileName,
      message:'Inspecting downloaded raw data…'});
    try{
      await this.remember(candidate);
      await currentToken(candidate.uid);
      const previous=await getRawRecordings(candidate.uid,20);
      const sameDevice=previous.filter(r=>r.deviceId===candidate.deviceId&&r.uploadStatus==='COMPLETE'&&r.sha256);
      const inspection=await inspectBin(candidate.fileUri,sameDevice.map(r=>r.byteSize),fraction=>
        this.publish({progress:fraction*.16,message:`Checking NAND file… ${Math.round(fraction*100)}%`})
      );
      if(inspection.parseWarnings) throw new Error(`NAND file has ${inspection.parseWarnings} structural parse warnings. Keeping local file; cloud backup is blocked pending review.`);
      if(inspection.sidecar?.device_id && inspection.sidecar.device_id!==candidate.deviceId){
        throw new Error('Downloaded file belongs to a different wristband. Reconnect the original device.');
      }
      const overlaps=sameDevice.filter(old=>old.byteSize<inspection.byteSize&&
        old.sha256===inspection.prefixSha256[String(old.byteSize)]);
      const existing=sameDevice.find(old=>old.byteSize===inspection.byteSize&&old.sha256===inspection.sha256);
      this.publish({totalBytes:inspection.byteSize,overlapCount:overlaps.length,indexedMinuteCount:inspection.minutes.length,
        undatedMinuteCount:inspection.undatedProcessedCount});
      const path=objectName(candidate.uid,candidate.deviceId,inspection.sha256);
      const recordingId=`${safePart(candidate.deviceId)}_${inspection.sha256}`;
      const base:RawRecordingMetadata={
        recordingId,source:'WRISTBAND_RAW_NAND',schemaVersion:2,fileName:candidate.fileName,
        storagePath:path,byteSize:inspection.byteSize,uploadedBytes:0,uploadStatus:'UPLOADING',
        deviceId:candidate.deviceId,deviceName:candidate.deviceName,
        pageSize:inspection.pageSize,committedSpanBytes:inspection.byteSize,
        sha256:inspection.sha256,supersedesIds:overlaps.map(o=>o.recordingId),
        timestampedProcessedCount:inspection.minutes.length-inspection.undatedProcessedCount,
        undatedProcessedCount:inspection.undatedProcessedCount,
        firstProcessedUnixMs:inspection.firstProcessedUnixMs??undefined,
        lastProcessedUnixMs:inspection.lastProcessedUnixMs??undefined,
      };
      pendingMetadata=base;
      // History and raw archival are independent: a transient Firestore history
      // failure must NOT prevent the original BIN from being archived.
      // Importing first also lets already-synced minute records appear even
      // while the potentially long raw upload is in progress or paused.
      base.historyImportedCount=existing?.historyImportedCount||0;
      base.historyImportComplete=existing?.historyImportComplete===true;
      if(!base.historyImportComplete){
        this.publish({phase:'importing',message:'Synchronizing dated 1-minute history…',progress:.16});
        try {
          const imported=await importBinMinuteHistory(candidate.uid,candidate.deviceId,inspection,(done,total)=>
            this.publish({progress:.16+.04*(total?done/total:1)})
          );
          base.historyImportedCount=imported.imported;
          base.historyImportComplete=true;
          base.historyErrorMessage=null;
        } catch(historyError:any) {
          historyFailure=String(historyError?.message||historyError);
          base.historyErrorMessage=historyFailure;
          console.warn('[RawCloud] Minute history import will need a retry, continuing with raw archive:',historyError);
        }
      }
      let remote=await remoteSize(path);
      if(remote && remote.md5Hash && remote.md5Hash!==inspection.md5Base64){
        throw new Error('Cloud MD5 does not match local BIN. Do not erase local or wristband data.');
      }
      if(remote&&remote.size!==inspection.byteSize){
        throw new Error('A cloud object already exists at this SHA-256 path with the wrong size. Upload blocked for safety.');
      }
      if(!remote){
        await saveRawRecordingMetadata(candidate.uid,{...base,uploadStatus:'UPLOADING'});
        this.publish({phase:'uploading',message:'Uploading verified raw backup…',progress:.2,totalBytes:inspection.byteSize});
        await this.uploadChunks(candidate.uid,inspection,path);
        this.publish({phase:'verifying',message:'Verifying cloud object size…',progress:.98});
        remote=await remoteSize(path);
      }
      if(!remote||remote.size!==inspection.byteSize)throw new Error('Cloud upload did not pass final remote size verification. Local BIN preserved.');
      if(!remote.md5Hash || remote.md5Hash!==inspection.md5Base64){
        throw new Error('Cloud MD5 checksum is unavailable or does not match the local BIN. Backup is NOT verified; keep local/NAND data and retry or investigate.');
      }
      // From here onward the remote raw bytes have passed size + MD5 checks.
      // Never downgrade their archival status to ERROR if subsequent Firestore
      // history or overlap bookkeeping fails.
      archiveVerified=true;
      await saveRawRecordingMetadata(candidate.uid,{
        ...base,uploadStatus:'COMPLETE',uploadedBytes:inspection.byteSize,
        storageGeneration:remote.generation,storageMd5Hash:remote.md5Hash,
        storageContentType:'application/octet-stream',
      });
      // Bookkeeping must never invalidate an otherwise verified raw backup.
      for(const old of overlaps){
        try {
          await setDoc(doc(db,'users',candidate.uid,'raw_recordings',old.recordingId),{
            supersededBy:recordingId,supersededAt:serverTimestamp(),
          },{merge:true});
        }catch(markError){console.warn('[RawCloud] Could not mark older verified snapshot:',markError);}
      }
      try {await AsyncStorage.removeItem(sessionKey(candidate.uid,inspection.sha256));}
      catch(cleanupError){console.warn('[RawCloud] Could not clear finished upload session:',cleanupError);}
      if(historyFailure){
        this.publish({phase:'error',error:`Raw BIN is safely archived and verified, but minute history import needs a retry: ${historyFailure}`,
          message:'Cloud raw backup verified; tap Retry to finish minute history.',
          sentBytes:inspection.byteSize,totalBytes:inspection.byteSize,progress:1,
          deduplicated:!!existing,overlapCount:overlaps.length});
      }else{
        this.publish({phase:'complete',message:existing?'Previously backed up — history synchronized.':
          `Cloud backup verified. ${overlaps.length} older overlapping snapshot(s) identified.`,
          sentBytes:inspection.byteSize,totalBytes:inspection.byteSize,progress:1,error:null,
          deduplicated:!!existing,overlapCount:overlaps.length});
      }
    }catch(error:any){
      const errorText=String(error?.message||error);
      if(pendingMetadata && auth.currentUser?.uid===candidate.uid){
        try{
          await saveRawRecordingMetadata(candidate.uid,archiveVerified?{
            ...pendingMetadata,uploadStatus:'COMPLETE',uploadedBytes:pendingMetadata.byteSize,
            // This write is a fallback if post-verification metadata failed.
            historyErrorMessage:pendingMetadata.historyErrorMessage||null,
          }:{
            ...pendingMetadata,uploadStatus:'ERROR',errorMessage:errorText,
            uploadedBytes:this.state.sentBytes,
          });
        }catch(metadataError){console.warn('[RawCloud] Could not save backup status:',metadataError);}
      }
      this.publish({phase:'error',error:archiveVerified?
        `Raw BIN was verified in the cloud but finishing its metadata failed. Retry safely: ${errorText}`:errorText,
        message:archiveVerified?'Raw cloud object is verified — finish metadata with Retry.':
          'Backup needs attention — local BIN is safe. Tap Retry.'});
    }finally{this.active=false;}
  }
  private async uploadChunks(uid:string,inspection:BinInspection,path:string):Promise<void>{
    const key=sessionKey(uid,inspection.sha256);
    let session:UploadSession|null=null;
    let offset=0;
    const stored=await AsyncStorage.getItem(key);
    if(stored){
      try{
        const candidate=JSON.parse(stored) as UploadSession;
        if(candidate.storagePath===path&&candidate.size===inspection.byteSize&&Date.now()-candidate.createdMs<20*60*60*1000){
          offset=await queryOffset(uid,candidate);session=candidate;
        }
      }catch{ /* Session expired or unreachable: a new session starts safely. */ }
    }
    if(!session){
      session=await startSession(uid,path,inspection.byteSize);
      await AsyncStorage.setItem(key,JSON.stringify(session));
    }
    const original=new File(inspection.fileUri);
    const reader=original.open();
    let lastProgressMs=0;
    try{
      while(offset<inspection.byteSize){
        if(this.cancelRequested)throw new Error('Backup paused. Retry later to continue from the confirmed cloud offset.');
        const count=Math.min(CHUNK_SIZE,inspection.byteSize-offset);
        reader.offset=offset;
        const bytes=reader.readBytes(count);
        if(bytes.length!==count)throw new Error('Local BIN changed during upload.');
        const tmp=new File(Paths.cache,`audiostim_upload_${inspection.sha256.slice(0,16)}.part`);
        if(tmp.exists)tmp.delete();
        tmp.create();
        tmp.write(bytes);
        // Release the 4 MiB typed array before the native upload starts.
        const before=offset;
        const command=offset+count===inspection.byteSize?'upload, finalize':'upload';
        try{
          const token=await currentToken(uid);
          const task=createUploadTask(session.url,tmp.uri,{
            httpMethod:'POST',uploadType:FileSystemUploadType.BINARY_CONTENT,
            headers:{
              'Content-Type':'application/octet-stream',
              'Authorization':`Firebase ${token}`,
              'X-Goog-Upload-Protocol':'resumable',
              'X-Goog-Upload-Offset':String(offset),
              'X-Goog-Upload-Command':command,
            },
          },progress=>{
            const now=Date.now();
            if(now-lastProgressMs<250 && progress.totalBytesSent<count) return;
            lastProgressMs=now;
            const current=before+Math.min(count,progress.totalBytesSent);
            this.publish({sentBytes:current,progress:.2+.78*(current/inspection.byteSize),
              message:`Backing up raw data… ${Math.round(current/inspection.byteSize*100)}%`});
          });
          const response=await task.uploadAsync();
          if(!response||![200,201,308].includes(response.status)){
            throw new Error(`Native upload returned HTTP ${response?.status??'unknown'}`);
          }
        }catch(error){
          // Server may have received a chunk even if Android lost the reply.
          // The session query is authoritative. Never assume local bytes were sent.
          try {offset=await queryOffset(uid,session);}
          catch {throw error;}
          if(offset<=before)throw error;
          continue;
        }finally{
          if(tmp.exists)tmp.delete();
        }
        // Verify the confirmed remote offset for each 4 MiB step. Finalized
        // uploads sometimes no longer accept session queries; metadata is final authority.
        if(command.includes('finalize')){
          const meta=await remoteSize(path);
          if(meta?.size!==inspection.byteSize)throw new Error('Last chunk sent but final object is not yet verified. Retry to confirm.');
          offset=inspection.byteSize;
        }else{
          offset=await queryOffset(uid,session);
          if(offset<=before)throw new Error('Storage did not confirm the most recent chunk; retry required.');
        }
      }
    }finally{reader.close();}
  }
}
export const rawCloudBackupService=new RawCloudBackupService();
