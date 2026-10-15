let channelSequence = 0;

// realtime-js returns an existing channel with the same topic, including one that is still leaving,
// and ignores subscribe() on it. A unique topic per subscription keeps re-created effects working.
export function uniqueRealtimeChannelName(base: string) {
  channelSequence += 1;
  return `${base}_${Date.now().toString(36)}${channelSequence.toString(36)}`;
}
