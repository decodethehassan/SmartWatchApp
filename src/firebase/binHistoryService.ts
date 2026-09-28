import { collection, doc, getDocs, orderBy, query, Timestamp, where, writeBatch } from 'firebase/firestore';
import { db } from './firebaseConfig';
import type { MinuteSummaryReading } from './sensorTypes';
import { parseV0Min } from '../functionality/SensorParser';
import type { BinInspection } from '../functionality/binInspectionService';

export type CanonicalMinuteRow = MinuteSummaryReading & { id: string };
/** A single device+UTC instant maps to one Firestore history document, regardless of BIN filename. */
export const canonicalMinuteId = (deviceId:string,unixMs:number):string => {
  const device=deviceId.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,90);
  if(!device||!Number.isSafeInteger(unixMs)) throw new Error('Stable device ID and Unix milliseconds required');
  return `${device}_${unixMs}`;
};

/** Only timestamped V0 minutes are imported. No missing history is extrapolated. */
export async function importBinMinuteHistory(
  uid:string,deviceId:string,inspection:BinInspection,
  onProgress?:(done:number,total:number)=>void,
):Promise<{imported:number;undated:number;unparseable:number}> {
  if(!uid||!deviceId) throw new Error('User and stable wristband ID are required.');
  const unique=new Map<string,Record<string,any>>();
  let invalid=0;
  for(const minute of inspection.minutes){
    if(minute.unixMs===null) continue;
    const parsed=parseV0Min(minute.text);
    if(!parsed){ invalid++;continue; }
    const id=canonicalMinuteId(deviceId,minute.unixMs);
    unique.set(id,{
      timestamp:Timestamp.fromMillis(minute.unixMs),
      firmwareUptimeMs:parsed.t_ms,
      historyIndex:-1, // This is a BIN page record, not a processed-memory index.
      source:'RAW_BIN',
      deviceId,
      activity:parsed.activity,
      activityConfidence:parsed.act_conf,
      artifactFraction:parsed.art_frac,
      heartRate:parsed.hr_bpm,
      hrCoverageSec:parsed.hr_coverage_sec,
      hrQuality:parsed.hr_quality,
      hrvRmssdMs:parsed.hrv_rmssd_ms,
      hrvQuality:parsed.hrv_quality,
      edaMuScl:parsed.eda_muSCL,
      edaSigmaScr:parsed.eda_sigmaSCR,
      edaQuality:parsed.eda_quality,
      edaConfidence:parsed.eda_confidence,
      temperatureC:parsed.temp_c,
      temperatureQuality:parsed.temp_quality,
      temperatureSlope5m:parsed.temp_slope_5m,
      sleepState:parsed.sleep_state,
      sleepConfidence:parsed.sleep_conf,
      timestampSource:'FIRMWARE_UNIX_MS',
      rawPage:minute.page,
      rawPageOffset:minute.pageOffset,
      rawBootSegment:minute.bootSegment,
      rawSnapshotSha256:inspection.sha256,
    });
  }
  const rows=[...unique.entries()];
  let completed=0;
  for(let offset=0;offset<rows.length;offset+=200){
    const batch=writeBatch(db);
    for(const [id,payload] of rows.slice(offset,offset+200)){
      batch.set(doc(db,'users',uid,'sensor_data','canonical_minutes','readings',id),payload,{merge:true});
    }
    await batch.commit(); // A partial import is safe to retry because IDs are deterministic.
    completed+=Math.min(200,rows.length-offset);
    onProgress?.(completed,rows.length);
  }
  return {imported:completed,undated:inspection.undatedProcessedCount,unparseable:invalid};
}

export async function getCanonicalMinuteSummariesForRange(
  uid:string,start:Date,end:Date,
):Promise<CanonicalMinuteRow[]> {
  if(!uid) return [];
  const q=query(
    collection(db,'users',uid,'sensor_data','canonical_minutes','readings'),
    where('timestamp','>=',Timestamp.fromDate(start)),
    where('timestamp','<=',Timestamp.fromDate(end)),
    orderBy('timestamp','asc'),
  );
  const snap=await getDocs(q);
  return snap.docs.map(d=>({id:d.id,...(d.data() as MinuteSummaryReading)}));
}
