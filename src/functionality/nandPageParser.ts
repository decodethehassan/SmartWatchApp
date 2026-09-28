/** Format-compatible with firmware tools/decode_raw_bin.py, but keeps only V0/events.
 * Pure module so the page format and legacy timestamp handling can be tested offline. */
export type IndexedV0 = {
  bootSegment: number;
  page: number;
  pageOffset: number;
  firmwareUptimeMs: number;
  text: string;
  unixMs: number | null;
};
export type IndexedAnchor = { unixMs: number; uptimeMs: number };
const TIME_RE=/TIME_SYNC\s+unix_ms=(\d+)\s+uptime_ms=(\d+)/;
const BOOT_RE=/BOOT\s+uptime_ms=(\d+)/;
const V0_RE=/\bV0_MIN\s+t=(\d+)/;
const decodeASCII = (b: Uint8Array) => {
  // Firmware-generated EVENT and V0 records are ASCII text.
  let s='';for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);return s;
};
export function normalizeUnixMs(raw: number): number | null {
  const n=raw >= 1_000_000_000 && raw < 100_000_000_000 ? raw*1000 : raw;
  return Number.isFinite(n) && n >= Date.UTC(2020,0,1) && n <= Date.now()+86_400_000 ? n : null;
}
export class NandPageParser {
  readonly minutes: IndexedV0[]=[];
  readonly anchors = new Map<number,IndexedAnchor>();
  readonly counts: Record<string,number>={ppg:0,imu:0,eda:0,temperature:0,v0:0,event:0,other:0};
  segment=0;
  errors=0;
  parsePage(page: Uint8Array,pageIndex:number): void {
    let off=0;
    while(off+3<=page.length){
      if(page[off]===255) break;
      if(page[off]!==165){
        this.errors++;
        let next=off+1;
        while(next<page.length && page[next]!==165) next++;
        off=next;continue;
      }
      const type=page[off+1], len=page[off+2], end=off+3+len;
      if(end>page.length||end-off>256){this.errors++;break;}
      if(type===5){
        this.counts.v0++;
        const text=decodeASCII(page.subarray(off+3,end));
        const match=V0_RE.exec(text);
        if(match) this.minutes.push({bootSegment:this.segment,page:pageIndex,pageOffset:off,
          firmwareUptimeMs:Number(match[1]),text,unixMs:null});
      } else if(type===6){
        this.counts.event++;
        const text=decodeASCII(page.subarray(off+3,end));
        if(BOOT_RE.test(text)) this.segment++;
        const match=TIME_RE.exec(text);
        if(match){
          const unixMs=normalizeUnixMs(Number(match[1]));
          if(unixMs!==null) this.anchors.set(this.segment,{unixMs,uptimeMs:Number(match[2])});
        }
      } else if(type===1) this.counts.temperature++;
      else if(type===2) this.counts.imu++;
      else if(type===3) this.counts.ppg++;
      else if(type===4) this.counts.eda++;
      else this.counts.other++;
      off=end;
    }
  }
  finalize(sidecar?:{time_valid?:boolean;anchor_unix_ms?:number;anchor_uptime_ms?:number}):void {
    if(sidecar?.time_valid && Number.isFinite(sidecar.anchor_unix_ms) && Number.isFinite(sidecar.anchor_uptime_ms)
      && !this.anchors.has(this.segment)){
      const unixMs=normalizeUnixMs(Number(sidecar.anchor_unix_ms));
      if(unixMs!==null) this.anchors.set(this.segment,{unixMs,uptimeMs:Number(sidecar.anchor_uptime_ms)});
    }
    for(const minute of this.minutes){
      const anchor=this.anchors.get(minute.bootSegment);
      if(!anchor) continue; // Do not guess historical dates for legacy/undated records.
      const unix=anchor.unixMs+(minute.firmwareUptimeMs-anchor.uptimeMs);
      minute.unixMs=normalizeUnixMs(unix);
    }
  }
}
