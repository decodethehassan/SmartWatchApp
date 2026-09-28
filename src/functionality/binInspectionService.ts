import { File } from 'expo-file-system';
import { NandPageParser, type IndexedV0 } from './nandPageParser';
import { StreamSHA256 } from './streamSha256';
import { StreamMD5 } from './streamMd5';

export interface BinInspection {
  fileUri: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  md5Base64: string;
  /** SHA256 of exact initial byte ranges matching earlier complete BIN sizes. */
  prefixSha256: Record<string,string>;
  pageSize: number;
  counts: Record<string,number>;
  parseWarnings: number;
  minutes: IndexedV0[];
  firstProcessedUnixMs: number | null;
  lastProcessedUnixMs: number | null;
  undatedProcessedCount: number;
  sidecar: Record<string,unknown> | null;
}

/** One bounded pass: reads at most 128 KiB at a time, retaining only small V0/event indexes. */
export async function inspectBin(
  fileUri: string,
  earlierCompleteSizes: number[] = [],
  onProgress?: (fraction:number)=>void,
): Promise<BinInspection> {
  const f=new File(fileUri);
  if(!f.exists) throw new Error('Local raw BIN not found.');
  const byteSize=Number(f.size);
  if(!byteSize || byteSize%2048) throw new Error('Raw BIN is empty or not an exact sequence of 2048-byte NAND pages.');

  let sidecar:Record<string,unknown>|null=null;
  try {
    const meta=new File(`${fileUri}.meta.json`);
    if(meta.exists) sidecar=JSON.parse(await meta.text()) as Record<string,unknown>;
  } catch(error){ console.warn('[BIN] Invalid sidecar; only embedded TIME_SYNC anchors will be used.',error); }
  if(sidecar && (sidecar.complete !== true || Number(sidecar.total_bytes)!==byteSize)) {
    throw new Error('BIN sidecar reports an incomplete or mismatched raw transfer. Do not upload an incomplete snapshot.');
  }
  const sizes=[...new Set(earlierCompleteSizes)]
    .filter(s=>Number.isSafeInteger(s)&&s>0&&s<=byteSize)
    .sort((a,b)=>a-b);
  const prefixSha256:Record<string,string>={};
  const hash=new StreamSHA256();
  const md5=new StreamMD5();
  const nand=new NandPageParser();
  let offset=0, nextIndex=0;
  const reader=f.open();
  try {
    while(offset<byteSize){
      const toRead=Math.min(128*1024,byteSize-offset);
      reader.offset=offset;
      const chunk=reader.readBytes(toRead);
      if(chunk.length!==toRead) throw new Error(`Short BIN file read at byte ${offset}.`);
      md5.update(chunk);
      let part=0;
      while(nextIndex<sizes.length && sizes[nextIndex]<=offset+chunk.length){
        const boundary=sizes[nextIndex]-offset;
        if(boundary>part) hash.update(chunk.subarray(part,boundary));
        prefixSha256[String(sizes[nextIndex])]=hash.digestHex();
        part=boundary;
        nextIndex++;
      }
      if(part<chunk.length) hash.update(chunk.subarray(part));
      for(let i=0;i<chunk.length;i+=2048){
        nand.parsePage(chunk.subarray(i,i+2048),(offset+i)/2048);
      }
      offset+=chunk.length;
      if(offset%(2*1024*1024)===0||offset===byteSize) onProgress?.(offset/byteSize);
      // Let the UI and BLE thread run while indexing a 100+ MiB snapshot.
      if(offset%(2*1024*1024)===0) await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
  } finally { reader.close(); }
  nand.finalize(sidecar ? {
    time_valid:sidecar.time_valid===true,
    anchor_unix_ms:Number(sidecar.anchor_unix_ms),
    anchor_uptime_ms:Number(sidecar.anchor_uptime_ms),
  } : undefined);
  const valid=nand.minutes.map(m=>m.unixMs).filter((n):n is number=>n!==null).sort((a,b)=>a-b);
  return {
    fileUri,fileName:f.name,byteSize,sha256:hash.digestHex(),md5Base64:md5.digestBase64(),prefixSha256,pageSize:2048,
    counts:nand.counts,parseWarnings:nand.errors,minutes:nand.minutes,
    firstProcessedUnixMs:valid.length?valid[0]:null,
    lastProcessedUnixMs:valid.length?valid[valid.length-1]:null,
    undatedProcessedCount:nand.minutes.length-valid.length,
    sidecar,
  };
}
