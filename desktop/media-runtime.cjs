'use strict';

// Pinned Electron 45.2.2 contains this WebRTC H.264 packet buffer. The default
// buffer stalls on reordered native H.264 in our controlled loss/repair fixture.
// Configure before creating renderers; keep the test host on the same setting.
const SCREEN_VIDEO_TRIAL='WebRTC-Video-H26xPacketBuffer/Enabled/';
function configureScreenVideo(app){app.commandLine.appendSwitch('force-fieldtrials',SCREEN_VIDEO_TRIAL);}
module.exports={configureScreenVideo,SCREEN_VIDEO_TRIAL};
