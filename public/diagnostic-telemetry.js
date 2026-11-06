// Statistics only. No SDP, candidate addresses, labels or device names.
const keys=['bytesSent','bytesReceived','packetsSent','packetsReceived','packetsLost','jitter','roundTripTime','fractionLost','audioLevel','totalAudioEnergy','concealedSamples','totalSamplesReceived','concealmentEvents','framesDecoded','framesDropped','framesEncoded','framesPerSecond','frameWidth','frameHeight','freezeCount','totalFreezesDuration','jitterBufferDelay','jitterBufferEmittedCount','totalDecodeTime','totalEncodeTime','nackCount','pliCount','firCount'];
export function diagnosticRtp(reports){
  const rows=[];
  for(const r of reports.values()){
    if(!['inbound-rtp','outbound-rtp','remote-inbound-rtp'].includes(r.type))continue;
    const row={id:r.id,direction:r.type,kind:r.kind||r.mediaType,codec:reports.get(r.codecId)?.mimeType};
    for(const key of keys)if(typeof r[key]==='number'&&Number.isFinite(r[key]))row[key]=r[key];
    rows.push(row);if(rows.length>=10)break;
  }
  return rows;
}
keys.push('timestamp','framesReceived','keyFramesDecoded','packetsDiscarded','retransmittedPacketsReceived','retransmittedBytesReceived','totalAssemblyTime','framesAssembledFromMultiplePackets','totalProcessingDelay','jitterBufferTargetDelay','jitterBufferMinimumDelay','lastPacketReceivedTimestamp','pauseCount','totalPausesDuration');
