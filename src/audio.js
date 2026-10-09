export class AudioSystem {
  constructor(){this.enabled=true;this.context=null;this.last=0;}
  unlock(){if(!this.enabled)return;try{this.context??=new (window.AudioContext||window.webkitAudioContext)();this.context.resume();}catch{}}
  absorb(radius){if(!this.enabled||!this.context||performance.now()-this.last<80)return;this.last=performance.now();const c=this.context,o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.setValueAtTime(Math.max(70,220-radius*.15),c.currentTime);o.frequency.exponentialRampToValueAtTime(48,c.currentTime+.14);g.gain.setValueAtTime(.1,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.18);o.connect(g).connect(c.destination);o.start();o.stop(c.currentTime+.2);}
}
