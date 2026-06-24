// Reference monitor set — mirrors the Displays.html mock so a screenshot of the
// app rendered with these can be compared against the reference 1:1.
export const FIXTURE = [
  { name:'DP-1',     make:'Dell',  model:'U2720Q',  w:3840, h:2160, rate:60,  scale:1.5,  x:0,    y:0,    active:true,  primary:true,
    modes:[{w:3840,h:2160,rates:[60,30]},{w:2560,h:1440,rates:[60]},{w:1920,h:1080,rates:[60,30]}] },
  { name:'HDMI-A-1', make:'BenQ',  model:'GW2480',  w:1920, h:1080, rate:60,  scale:1.0,  x:3840, y:0,    active:true,  primary:false,
    modes:[{w:1920,h:1080,rates:[60,50]},{w:1680,h:1050,rates:[60]},{w:1280,h:720,rates:[60]}] },
  { name:'eDP-1',    make:'',      model:'Built-in',w:2560, h:1600, rate:120, scale:1.33, x:700,  y:2160, active:true,  primary:false,
    modes:[{w:2560,h:1600,rates:[120,60]},{w:1920,h:1200,rates:[60]},{w:1600,h:1000,rates:[60]}] },
];
