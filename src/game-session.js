/** One ownership token guards every asynchronous entry step. No obsolete run
 * can start, hide a newer map or attach its renderer after cancel/navigation. */
export class GameSession {
  constructor({renderer,gameFactory,onState=()=>{},onError=()=>{},onStatus=()=>{},transition=async()=>{},onReady=()=>{}}){Object.assign(this,{renderer,gameFactory,onState,onError,onStatus,transition,onReady});this.epoch=0;this.game=null;this.state='map';}
  setState(state){this.state=state;this.onState(state);}
  async enter(sector,{entryPoint=null,restart=false,mode='parts'}={}){
    const token=++this.epoch,started=performance.now(),previous=this.game;this.game=null;this.setState('loading');
    const current=()=>token===this.epoch;
    try{
      if(previous){try{await previous.persist();}catch(error){if(current()){this.game=previous;this.setState('paused');this.onError(error,'save');}else previous.dispose();return false;}previous.dispose();}if(!current())return false;this.renderer.dispose();
      const game=this.gameFactory({sector,mode,onStatus:(text,detail)=>{if(current())this.onStatus(text,detail);}});this.game=game;
      const run=await game.prepare(entryPoint,{restart});if(!current())return false;
      const manifest={...(game.sector||sector),tileMetadata:game.stream.metadata};
      this.onStatus('Рисуем дороги, воду и парки…',{phase:'renderer'});
      const rendered=await this.renderer.load(manifest,run,game.stream.source);if(!current())return false;if(!rendered||!this.renderer.ready)throw new Error('Карта не готова. Повтори загрузку.');
      this.renderer.maskDisplay=game.display;await game.persist();if(!current())return false;
      await this.transition(current);if(!current())return false;
      game.entryMilliseconds=performance.now()-started;this.onReady(game);this.setState('playing');return true;
    }catch(error){if(!current())return false;this.game?.dispose();this.game=null;this.renderer.dispose();this.setState('map');this.onError(error,'entry');return false;}
  }
  cancel(){this.epoch++;this.game?.dispose();this.game=null;this.renderer.dispose();this.setState('map');}
  async leave(){const token=++this.epoch,game=this.game;this.game=null;this.setState('leaving');try{await game?.persist();}catch(error){if(token===this.epoch){this.game=game;this.setState('paused');this.onError(error,'save');}else game?.dispose();return false;}game?.dispose();if(token!==this.epoch)return false;this.renderer.dispose();this.setState('map');return true;}
  pause(){if(this.state!=='playing')return;this.game?.suspend?.();this.setState('paused');this.game?.persist().catch(error=>this.onError(error,'save'));}
  resume(){if(this.state!=='paused')return;this.game?.resume?.();this.setState('playing');}
}
