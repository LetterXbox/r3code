// R3 Code's microphone helper (built by tools/run_local.py with swiftc, run by desktop/audioCapture.ts as a child of
// the app so macOS asks for the microphone in the app's name).
//   t3-mic list                                   -> JSON [{"uid","name","default"}] of the input devices
//   t3-mic record <wav> <levels> <stop> <maxSeconds> [deviceUID]
//       records the device (or the system default input) through AVAudioEngine, converts to 16 kHz mono float32 and
//       streams it into <wav> (sizes patched at the end, so the file is readable while it grows), writes
//       {"level","seconds"} to <levels> every 50 ms, stops when <stop> exists or after maxSeconds, prints {"seconds"}.
import AVFoundation
import CoreAudio
import Foundation

func out(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ initial: T) -> T? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let text = value?.takeRetainedValue() else { return nil }
  return text as String
}

func inputChannels(_ device: AudioObjectID) -> Int {
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func inputDevices() -> [(id: AudioObjectID, uid: String, name: String)] {
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.compactMap { id in
    guard inputChannels(id) > 0, let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
    return (id, uid, stringProperty(id, kAudioObjectPropertyName) ?? uid)
  }
}

func defaultInput() -> AudioObjectID? { property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, AudioObjectID(0)) }

func fail(_ code: String) -> Never { out(["error": code]); exit(1) }

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "list" {
  let fallback = defaultInput()
  out(inputDevices().map { ["uid": $0.uid, "name": $0.name, "default": $0.id == fallback] as [String: Any] })
  exit(0)
}
guard args.count >= 6, args[1] == "record" else { FileHandle.standardError.write("usage: t3-mic list | record <wav> <levels> <stop> <maxSeconds> [deviceUID]\n".data(using: .utf8)!); exit(2) }
let wavPath = args[2], levelsPath = args[3], stopPath = args[4]
let maxSeconds = Double(args[5]) ?? 300
let wantedUID = args.count >= 7 && !args[6].isEmpty ? args[6] : nil

// Microphone permission (the prompt names the responsible app: the app that started this helper).
let permission = DispatchSemaphore(value: 0)
var granted = false
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized: granted = true
case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { granted = $0; permission.signal() }; permission.wait()
default: granted = false
}
if !granted { fail("not-allowed") }

var deviceID: AudioObjectID? = nil
if let wantedUID {
  guard let match = inputDevices().first(where: { $0.uid == wantedUID }) else { fail("audio-capture") }
  deviceID = match.id
}

let engine = AVAudioEngine()
let input = engine.inputNode
if var id = deviceID, let unit = input.audioUnit {
  let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioObjectID>.size))
  if status != noErr { fail("audio-capture") }
}
let sourceFormat = input.inputFormat(forBus: 0)
if sourceFormat.sampleRate <= 0 || sourceFormat.channelCount == 0 { fail("audio-capture") }
// Mono at the source rate first (channel 0), then the converter only resamples.
let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sourceFormat.sampleRate, channels: 1, interleaved: false)!
let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
guard let converter = AVAudioConverter(from: monoFormat, to: targetFormat) else { fail("audio-capture") }

guard FileManager.default.createFile(atPath: wavPath, contents: nil), let file = FileHandle(forWritingAtPath: wavPath) else { fail("audio-capture") }
func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
func header(dataBytes: UInt32) -> Data {
  var h = Data("RIFF".utf8); h += le32(36 &+ dataBytes); h += Data("WAVE".utf8)
  h += Data("fmt ".utf8); h += le32(16); h += le16(3); h += le16(1); h += le32(16_000); h += le32(64_000); h += le16(4); h += le16(32)
  h += Data("data".utf8); h += le32(dataBytes)
  return h
}
file.write(header(dataBytes: 0xFFFF_FFDB)) // a growing file: sizes are unknown until stop

let lock = NSLock()
var written: UInt64 = 0
var level: Float = 0
var lastError: String? = nil
input.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { buffer, _ in
  guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
  let frames = Int(buffer.frameLength)
  guard let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
  mono.frameLength = AVAudioFrameCount(frames)
  mono.floatChannelData![0].update(from: channel, count: frames)
  var sum: Float = 0
  for i in 0..<frames { sum += channel[i] * channel[i] }
  let rms = sqrt(sum / Float(frames))
  let capacity = AVAudioFrameCount(Double(frames) * 16_000 / sourceFormat.sampleRate) + 32
  guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
  var fed = false
  var error: NSError?
  converter.convert(to: converted, error: &error) { _, status in
    if fed { status.pointee = .noDataNow; return nil }
    fed = true; status.pointee = .haveData; return mono
  }
  if error != nil { lock.lock(); lastError = "audio-capture"; lock.unlock(); return }
  let count = Int(converted.frameLength)
  if count > 0 { file.write(Data(bytes: converted.floatChannelData![0], count: count * 4)) }
  lock.lock(); written += UInt64(count * 4); level = min(1, rms * 4); lock.unlock()
}
engine.prepare()
do { try engine.start() } catch { fail("audio-capture") }

let started = Date()
while true {
  Thread.sleep(forTimeInterval: 0.05)
  lock.lock(); let current = level; let bytes = written; lock.unlock()
  let seconds = Date().timeIntervalSince(started)
  if bytes > 0, let json = try? JSONSerialization.data(withJSONObject: ["level": Double(current), "seconds": seconds]) {
    try? json.write(to: URL(fileURLWithPath: levelsPath), options: .atomic)
  }
  if FileManager.default.fileExists(atPath: stopPath) || seconds >= maxSeconds || lastError != nil { break }
}
input.removeTap(onBus: 0)
engine.stop()
lock.lock(); let total = written; lock.unlock()
file.seek(toFileOffset: 0)
file.write(header(dataBytes: UInt32(min(total, UInt64(UInt32.max - 36)))))
file.closeFile()
if let lastError { fail(lastError) }
out(["seconds": Double(total) / 64_000])
