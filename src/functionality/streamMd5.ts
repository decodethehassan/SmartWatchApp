/** Streaming RFC 1321 MD5 for comparing with Firebase Storage md5Hash.
 * This is for accidental transport corruption detection, NOT identity/security;
 * exact snapshot identification uses SHA-256 separately. */
const SHIFTS=[
  7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
  5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
  4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
  6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21,
];
const TABLE=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*0x100000000)>>>0);
const rol=(n:number,s:number)=>((n<<s)|(n>>>(32-s)))>>>0;
const ABC='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export class StreamMD5 {
  private h=new Uint32Array([0x67452301,0xefcdab89,0x98badcfe,0x10325476]);
  private block=new Uint8Array(64);
  private pos=0;
  private byteCount=0;
  update(bytes:Uint8Array):this{
    this.byteCount+=bytes.length;
    let i=0;
    while(i<bytes.length){
      const n=Math.min(64-this.pos,bytes.length-i);
      this.block.set(bytes.subarray(i,i+n),this.pos);
      this.pos+=n;i+=n;
      if(this.pos===64){this.compress();this.pos=0;}
    }
    return this;
  }
  private compress():void{
    const words=new Uint32Array(16);
    for(let i=0;i<16;i++){
      const j=i*4;
      words[i]=(this.block[j]|(this.block[j+1]<<8)|(this.block[j+2]<<16)|(this.block[j+3]<<24))>>>0;
    }
    let [a,b,c,d]=Array.from(this.h);
    for(let i=0;i<64;i++){
      let f:number,g:number;
      if(i<16){f=(b&c)|(~b&d);g=i;}
      else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16;}
      else if(i<48){f=b^c^d;g=(3*i+5)%16;}
      else {f=c^(b|(~d));g=(7*i)%16;}
      const oldD=d;
      d=c;c=b;
      b=(b+rol((a+f+TABLE[i]+words[g])>>>0,SHIFTS[i]))>>>0;
      a=oldD;
    }
    this.h[0]=(this.h[0]+a)>>>0;
    this.h[1]=(this.h[1]+b)>>>0;
    this.h[2]=(this.h[2]+c)>>>0;
    this.h[3]=(this.h[3]+d)>>>0;
  }
  digestBytes():Uint8Array{
    const bitHi=Math.floor(this.byteCount/0x20000000)>>>0;
    const bitLo=(this.byteCount*8)>>>0;
    // The final padding changes the object; do not call update/digest twice.
    this.update(new Uint8Array([128]));
    while(this.pos!==56) this.update(new Uint8Array([0]));
    const end=new Uint8Array(8);
    for(let i=0;i<4;i++){
      end[i]=(bitLo>>>(8*i))&255;
      end[i+4]=(bitHi>>>(8*i))&255;
    }
    this.update(end);
    const result=new Uint8Array(16);
    for(let i=0;i<4;i++)for(let j=0;j<4;j++)result[i*4+j]=(this.h[i]>>>(8*j))&255;
    return result;
  }
  digestBase64():string{
    const b=this.digestBytes();let result='';
    for(let i=0;i<b.length;i+=3){
      const n=(b[i]<<16)|((b[i+1]??0)<<8)|(b[i+2]??0);
      result+=ABC[(n>>>18)&63]+ABC[(n>>>12)&63]+
        (i+1<b.length?ABC[(n>>>6)&63]:'=')+
        (i+2<b.length?ABC[n&63]:'=');
    }
    return result;
  }
}
