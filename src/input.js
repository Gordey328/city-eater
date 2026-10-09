export class HoleController {
  constructor(active,onPause){
    this.active=active;this.onPause=onPause;this.keys=new Set();this.vector=[0,0];this.pointer=null;this.origin=null;
    this.joystick=document.querySelector('#joystick');this.knob=document.querySelector('#joystick-knob');
    document.addEventListener('keydown',e=>{if(e.code==='Escape'){e.preventDefault();if(!e.repeat)onPause();return;}if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)&&active()){e.preventDefault();this.keys.add(e.code);}});
    document.addEventListener('keyup',e=>this.keys.delete(e.code));
    window.addEventListener('blur',()=>this.reset());
    document.addEventListener('pointerdown',e=>{
      if(!active()||e.target.closest('button,a,input,select,.panel')||this.pointer!==null)return;
      this.pointer=e.pointerId;this.origin=[e.clientX,e.clientY];this.joystick.style.left=`${Math.max(66,Math.min(innerWidth-66,e.clientX))}px`;this.joystick.style.top=`${Math.max(86,Math.min(innerHeight-90,e.clientY))}px`;this.joystick.classList.add('visible');
      document.body.setPointerCapture?.(e.pointerId);e.preventDefault();
    },{passive:false});
    document.addEventListener('pointermove',e=>{if(e.pointerId!==this.pointer||!this.origin)return;const dx=e.clientX-this.origin[0],dy=e.clientY-this.origin[1],len=Math.hypot(dx,dy),scale=Math.min(1,54/(len||1));this.vector=[dx/54*scale,-dy/54*scale];this.knob.style.transform=`translate(${dx*scale}px,${dy*scale}px)`;e.preventDefault();},{passive:false});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(event,e=>{if(e.pointerId===this.pointer)this.reset();});
  }
  direction(){let x=this.vector[0],y=this.vector[1];if(this.keys.has('KeyW')||this.keys.has('ArrowUp'))y++;if(this.keys.has('KeyS')||this.keys.has('ArrowDown'))y--;if(this.keys.has('KeyA')||this.keys.has('ArrowLeft'))x--;if(this.keys.has('KeyD')||this.keys.has('ArrowRight'))x++;const n=Math.max(1,Math.hypot(x,y));return[x/n,y/n];}
  reset(){this.keys.clear();this.vector=[0,0];this.pointer=null;this.origin=null;this.joystick.classList.remove('visible');this.knob.style.transform='';}
}
