// AudioWorklet processor — runs on the audio thread
// Collects mic samples and posts them back to the main thread in chunks
class SampleCollector extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Transfer a copy so the main thread can read it
      this.port.postMessage(input[0].slice());
    }
    return true; // keep processor alive
  }
}

registerProcessor('sample-collector', SampleCollector);
