# WubLabz Adversarial Code Audit & Correctness Review

## A. Correctness Risks

### 1. Aliasing Noise via Unfiltered Decimation Resampling
* **File:Line Reference**: [arranger.ts](file:///home/gulfcoastorganics/wublabz/src/lib/producer-tools/arranger.ts#L1073-L1083)
* **Risk Severity**: **High**
* **Technical Description**: Resampling from the source stem rate to the render target rate is performed using nearest-neighbor decimation: `Math.floor((i * source.sampleRate) / sampleRate)`. This crude index mapping introduces significant high-frequency foldback (aliasing) distortion into the audible spectrum because it lacks an anti-aliasing low-pass filter (e.g. Kaiser window or sinc interpolation).
* **Audio Assessment**: UNVERIFIABLE BY STATIC ANALYSIS — requires listening.

### 2. Comb-Filtering and Phase Shift in Mono-Low Summing
* **File:Line Reference**: [outputQuality.ts](file:///home/gulfcoastorganics/wublabz/src/lib/audio/outputQuality.ts#L170-L178)
* **Risk Severity**: **High**
* **Technical Description**: Low-frequency mono-summing is executed by running a one-pole low-pass filter and subtracting the result from the original stereo signals: `(left[i] - lowLeft[i]) + monoLow`. A one-pole filter introduces a frequency-dependent phase delay. Subtracting this phase-shifted signal from the original signal creates destructive and constructive phase interference (comb-filtering) around the crossover frequency, degrading the low-mid frequency response of the master track.
* **Audio Assessment**: UNVERIFIABLE BY STATIC ANALYSIS — requires listening.

### 3. Non-Physical Intersample Peak Approximation
* **File:Line Reference**: [outputQuality.ts](file:///home/gulfcoastorganics/wublabz/src/lib/audio/outputQuality.ts#L226-L237)
* **Risk Severity**: **Medium-High**
* **Technical Description**: Intersample peak levels are calculated via a non-standard heuristic: `transitionOvershoot = Math.abs(current - previous) * 0.02`. Real intersample peaks result from reconstruction sinc interpolation. A fixed 2% overshoot scaling factor is physically incorrect and will fail to detect clipping on high-frequency transients, causing silent clipping on consumer DAC playback paths.
* **Audio Assessment**: UNVERIFIABLE BY STATIC ANALYSIS — requires listening.

### 4. Incorrect Gain Mapping During Section Frame Gaps
* **File:Line Reference**: [arranger.ts](file:///home/gulfcoastorganics/wublabz/src/lib/producer-tools/arranger.ts#L371-L379)
* **Risk Severity**: **Medium**
* **Technical Description**: In `mixArrangementStemsWithContext`, the segment index `si` is incremented sequentially: `while (si < segments.length - 1 && i >= segments[si].endFrame) si++`. If a rounding error or gap occurs between two sections (e.g., `segments[si].endFrame < segments[si+1].startFrame`), the pointer remains stuck on the previous segment. The gain interpolation calculation `(i - seg.startFrame) / span` exceeds `1.0` and is clamped, incorrectly sustaining the old section's gain across the gap.

### 5. Memory Leaks and Node Accumulation in Background Tabs
* **File:Line Reference**: [ToneAdapter.ts](file:///home/gulfcoastorganics/wublabz/src/lib/playback/ToneAdapter.ts#L514-L523)
* **Risk Severity**: **Medium**
* **Technical Description**: `ToneAdapter` schedules player resource disposal using JavaScript `setTimeout` callbacks. While the Web Audio context clock runs on a dedicated high-priority audio thread, browsers heavily throttle or freeze `setTimeout` execution in background tabs. Backgrounding the tab causes the player disposal callbacks to stall, causing active `Tone.Player` memory allocations to accumulate.

### 6. Playback Crashes via Oscillator Re-activation
* **File:Line Reference**: [GrowlVoiceGraph.ts](file:///home/gulfcoastorganics/wublabz/src/lib/audio/GrowlVoiceGraph.ts#L204-L209)
* **Risk Severity**: **Medium-Low**
* **Technical Description**: Calling `start()` on an `OscillatorNode` that has already been started or stopped throws an `InvalidStateError`. Unlike `stop()`, the `start()` invocations are not protected by try-catch blocks. If a voice graph instance is reused due to a scheduling race condition, the engine will crash with an unhandled exception.

### 7. File Corruption via Concurrent Cache Miss Race Conditions
* **File:Line Reference**: [LocalDemucsSeparator.ts](file:///home/gulfcoastorganics/wublabz/src/flip-worker/LocalDemucsSeparator.ts#L28-L49)
* **Risk Severity**: **Medium-Low**
* **Technical Description**: Cache checks are asynchronous. If two requests for the same file hash are processed in parallel, both will miss the cache check and spawn concurrent Python `demucs` subprocesses writing to the same temporary directories, leading to file corruption.

---

## B. Dead Code / Drift

### 1. Unused Mix Routine
* **File:Line Reference**: [arranger.ts](file:///home/gulfcoastorganics/wublabz/src/lib/producer-tools/arranger.ts#L330-L342)
* **Description**: `mixArrangementStems` is defined and implements a fixed `0.75` gain multiplication. It is completely unused by active arrangement export paths which exclusively call `mixArrangementStemsWithContext`.

### 2. Hardcoded Swing Drift
* **File:Line Reference**: [arranger.ts](file:///home/gulfcoastorganics/wublabz/src/lib/producer-tools/arranger.ts#L593) vs [arranger.ts](file:///home/gulfcoastorganics/wublabz/src/lib/producer-tools/arranger.ts#L838)
* **Description**: In `renderDrumClip`, the swing ratio is read dynamically from the payload with a fallback of `0.04`. In `renderBassClip` at line 838, the swing ratio is hard-coded to `0.04`: `const swingRatio = 0.04;`. If the drum track's swing is modified by the generator, the bass track will drift out of sync.
* **Audio Assessment**: UNVERIFIABLE BY STATIC ANALYSIS — requires listening.

---

## C. Fragility

### 1. Out-of-Memory Panics on High Sample Rate Audio
* **File:Line Reference**: [analyze_and_stretch.py](file:///home/gulfcoastorganics/wublabz/src/flip-worker/python/analyze_and_stretch.py#L64)
* **Description**: `librosa.load(..., sr=None, mono=True)` decodes the entire file into memory synchronously. For high-sample-rate files (e.g. 192kHz/24-bit), this creates huge numpy arrays on the CPU-only target's memory heap, triggering OOM kernel panics.

### 2. Channel Phase De-Correlation Fallback
* **File:Line Reference**: [analyze_and_stretch.py](file:///home/gulfcoastorganics/wublabz/src/flip-worker/python/analyze_and_stretch.py#L45-L49)
* **Description**: If `pyrubberband` is missing (e.g. `rubberband-cli` is not installed on the system), the script falls back to processing channels independently: `np.vstack([librosa.effects.time_stretch(channel, rate=rate) for channel in y])`. This channel-by-channel phase-vocoder implementation degrades the stereo image of the vocal stem, causing hollow comb-filtering.
* **Audio Assessment**: UNVERIFIABLE BY STATIC ANALYSIS — requires listening.

### 3. Argument Hijacking via Hyphenated Filenames
* **File:Line Reference**: [LocalDemucsSeparator.ts](file:///home/gulfcoastorganics/wublabz/src/flip-worker/LocalDemucsSeparator.ts#L64-L74)
* **Description**: Input filenames starting with a hyphen (e.g., `-o.wav` or `--help`) are appended directly to the subprocess arguments array: `args.push(inputPath)`. This allows parameter injection that hijacks the Python interpreter's CLI argument parser.

---

## D. Test Gaps

### 1. Missing Coverage for Mastering and Export DSP
* **File:Line Reference**: [outputQuality.ts](file:///home/gulfcoastorganics/wublabz/src/lib/audio/outputQuality.ts#L1)
* **Description**: The Vitest test suite contains zero test files or assertions for `outputQuality.ts`. The soft limiters, makeup gain staging, glue compressor, and peak calculation code are completely untested.

### 2. Low-Resolution Test Buffers
* **File:Line Reference**: [producerTools.test.ts](file:///home/gulfcoastorganics/wublabz/tests/producerTools.test.ts#L330-L344)
* **Description**: Arranger render tests run at a mocked sample rate of `8000 Hz` using a flat array of `0.25` dummy values. This fails to test actual high-frequency aliasing or floating-point overflows at standard sample rates (44.1kHz or 48kHz).

### 3. Mocked Transport Clock
* **File:Line Reference**: [toneAdapter.test.ts](file:///home/gulfcoastorganics/wublabz/tests/toneAdapter.test.ts#L13-L30)
* **Description**: Time-based events are tested using virtual clocks and stubs. Actual asynchronous timing drifts, execution pauses in background threads, and garbage collection behaviors are completely unverified.

---

## E. The Three Things Least Sure About

### 1. Browser AudioBuffer Memory Eviction
* We are unsure whether the browser engine releases raw `AudioBuffer` allocations immediately when references are deleted from `clipsBySourcePath`. If the garbage collection cycles are delayed, consecutive remix generations will trigger heap bloat.

### 2. Rubberband CLI Binary Availability
* The python script relies on `import pyrubberband`, which requires the compiled binary `rubberband` to be present on the host OS. If this binary is missing or configured differently, the system falls back to channel-de-correlated Librosa time-stretching, which degradates stereo width.

### 3. Active WaveShaper Parameter Modulations
* We are unsure whether updating the waveshaper distortion curve in real-time causes transient clicks during active audio playback. Since we cannot hear the output, we cannot confirm if the lookup table updates are smoothed by the browser.
