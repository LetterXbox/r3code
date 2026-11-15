// A native web view does not bubble wheel events to the surrounding GPUI list.
// Leave the event to an inner scroller if it can move in this direction;
// otherwise forward vertical wheel input to the conversation.
export const HTML_RENDER_WHEEL_SCRIPT = `(function(){
  if(window.__r3TimelineWheel)return;window.__r3TimelineWheel=true;
  window.addEventListener('wheel',function(e){
    if(e.defaultPrevented||e.ctrlKey||e.metaKey||!e.deltaY||Math.abs(e.deltaX)>Math.abs(e.deltaY))return;
    var n=e.target instanceof Element?e.target:null,root=document.scrollingElement;
    while(n){
      var style=getComputedStyle(n),overflow=style.overflowY;
      // HTML propagates the body's overflow to the viewport when the root
      // leaves overflow visible. Respect that rule before claiming it scrolls.
      if(n===root&&n===document.documentElement&&overflow==='visible'&&document.body){
        var bodyOverflow=getComputedStyle(document.body).overflowY;
        if(bodyOverflow!=='visible')overflow=bodyOverflow;
      }
      if(((n===root&&overflow!=='hidden'&&overflow!=='clip')||overflow==='auto'||overflow==='scroll'||overflow==='overlay')&&
         n.scrollHeight>n.clientHeight+1&&
         (e.deltaY<0?n.scrollTop>0:n.scrollTop+n.clientHeight<n.scrollHeight-1))return;
      n=n.parentElement;
    }
    var delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?window.innerHeight:1);
    try{window.nsh.postMessage(JSON.stringify({timelineWheel:delta}));e.preventDefault();}catch(_){}
  },{passive:false});
})();true;`;

export function readTimelineWheel(data: string): number | undefined {
  try {
    const message: unknown = JSON.parse(data);
    if (message === null || typeof message !== "object" || !("timelineWheel" in message)) return undefined;
    const delta = message.timelineWheel;
    return typeof delta === "number" && Number.isFinite(delta) && delta !== 0 ? delta : undefined;
  } catch { return undefined; }
}

/** Forward a WebView wheel as a reader gesture, preserving follow at the live end. */
export function forwardArtifactWheel(delta: number, io: {
  cancelRestore: () => void;
  follow: {
    beginUserScroll: () => void;
    navigate: (navigation: { source: "wheel"; direction: "up" | "down" }) => void;
    endUserScroll: () => void;
  };
  scroll: (delta: number) => void;
}): void {
  io.cancelRestore();
  io.follow.beginUserScroll();
  io.follow.navigate({ source: "wheel", direction: delta < 0 ? "up" : "down" });
  io.scroll(delta);
  // A forwarded WebView event has no native List gesture-end event.
  io.follow.endUserScroll();
}
