//! The CPAL stream never leaves its dedicated thread. Neither native permission
//! prompts nor resampling can block Tauri's UI thread.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{FftFixedInOut, Resampler};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, watch};

pub const MAX_SECONDS: u64 = 120;
const OUTPUT_RATE: usize = 16_000;

#[derive(Clone)]
pub enum RecordingStatus {
    Starting,
    Recording,
    Ready(Arc<Vec<u8>>),
    Failed(String),
    Cancelled,
}

pub enum Stop {
    Finish,
    Cancel,
}

pub fn spawn(
    stop: mpsc::Receiver<Stop>,
    status: watch::Sender<RecordingStatus>,
    ready: oneshot::Sender<Result<(), String>>,
    on_stopped: impl Fn(&str, Option<String>) + Send + 'static,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("shard-voice-recording".into())
        .spawn(move || {
            let mut ready = Some(ready);
            if let Err(error) = record(stop, &status, &mut ready, &on_stopped) {
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(error.clone()));
                } else {
                    on_stopped("error", Some(error.clone()));
                }
                status.send_replace(RecordingStatus::Failed(error));
            }
        })
        .map(|_| ())
        .map_err(|_| "无法启动录音线程。".to_string())
}

fn record(
    stop: mpsc::Receiver<Stop>,
    status: &watch::Sender<RecordingStatus>,
    ready: &mut Option<oneshot::Sender<Result<(), String>>>,
    on_stopped: &impl Fn(&str, Option<String>),
) -> Result<(), String> {
    if !microphone_permission(&stop)? {
        status.send_replace(RecordingStatus::Cancelled);
        if let Some(sender) = ready.take() {
            let _ = sender.send(Err("录音已取消。".into()));
        }
        return Ok(());
    }
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("没有可用的麦克风，请连接麦克风后重试。")?;
    let supported = device
        .default_input_config()
        .map_err(|_| "无法访问麦克风，请检查系统麦克风权限和设备。")?;
    let config = supported.config();
    let rate = config.sample_rate.0 as usize;
    let channels = config.channels as usize;
    if channels == 0 || !(8_000..=192_000).contains(&rate) {
        return Err("麦克风采样格式不受支持。".into());
    }
    let limit = rate * MAX_SECONDS as usize;
    // Allocate before opening the stream. The audio callback only try-locks and
    // pushes into this reserved capacity; it performs no network or file work.
    let samples = Arc::new(Mutex::new(Vec::with_capacity(limit)));
    let failed = Arc::new(AtomicBool::new(false));
    let full = Arc::new(AtomicBool::new(false));
    macro_rules! stream {
        ($ty:ty) => {
            build_stream::<$ty>(
                &device,
                &config,
                channels,
                limit,
                samples.clone(),
                failed.clone(),
                full.clone(),
            )
        };
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => stream!(f32),
        cpal::SampleFormat::F64 => stream!(f64),
        cpal::SampleFormat::I8 => stream!(i8),
        cpal::SampleFormat::I16 => stream!(i16),
        cpal::SampleFormat::I32 => stream!(i32),
        cpal::SampleFormat::I64 => stream!(i64),
        cpal::SampleFormat::U8 => stream!(u8),
        cpal::SampleFormat::U16 => stream!(u16),
        cpal::SampleFormat::U32 => stream!(u32),
        cpal::SampleFormat::U64 => stream!(u64),
        _ => return Err("麦克风采样格式不受支持。".into()),
    }
    .map_err(|_| "无法启动麦克风，请在系统设置中允许 Shard 使用麦克风。")?;
    // Cancellation can arrive while the OS is presenting its permission prompt.
    if matches!(stop.try_recv(), Ok(Stop::Cancel)) {
        status.send_replace(RecordingStatus::Cancelled);
        if let Some(sender) = ready.take() {
            let _ = sender.send(Err("录音已取消。".into()));
        }
        return Ok(());
    }
    stream
        .play()
        .map_err(|_| "无法开始录音，请检查麦克风设备。")?;
    status.send_replace(RecordingStatus::Recording);
    if let Some(sender) = ready.take() {
        let _ = sender.send(Ok(()));
    }
    let started = Instant::now();
    let hit_limit = loop {
        match stop.recv_timeout(Duration::from_millis(25)) {
            Ok(Stop::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                drop(stream);
                status.send_replace(RecordingStatus::Cancelled);
                return Ok(());
            }
            Ok(Stop::Finish) => break false,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if failed.load(Ordering::Relaxed) {
            return Err("麦克风连接中断，请重新录音。".into());
        }
        if full.load(Ordering::Relaxed) || started.elapsed() >= Duration::from_secs(MAX_SECONDS) {
            break true;
        }
    };
    drop(stream);
    let input = samples.lock().map_err(|_| "无法读取录音。")?;
    if input.len() < rate / 5 {
        return Err("录音太短，请重新录音。".into());
    }
    let wav = encode_wav(&input, rate)?;
    status.send_replace(RecordingStatus::Ready(Arc::new(wav)));
    if hit_limit {
        on_stopped("limit", None);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn microphone_permission(stop: &mpsc::Receiver<Stop>) -> Result<bool, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    // AVFoundation accepts this constant on any thread. The completion block
    // only sends a boolean; it never touches UI and remains safe after cancel.
    let media_type = unsafe { AVMediaTypeAudio }.ok_or("系统不支持麦克风授权。")?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    if status == AVAuthorizationStatus::Authorized {
        return Ok(true);
    }
    let denied = "麦克风权限未开启，请在系统设置的「隐私与安全性 → 麦克风」中允许 Shard。";
    if status != AVAuthorizationStatus::NotDetermined {
        return Err(denied.into());
    }
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |granted: Bool| {
        let _ = sender.send(granted.as_bool());
    });
    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
    }
    loop {
        match receiver.try_recv() {
            Ok(true) => return Ok(true),
            Ok(false) => return Err(denied.into()),
            Err(mpsc::TryRecvError::Disconnected) => return Err("麦克风授权请求失败。".into()),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match stop.recv_timeout(Duration::from_millis(25)) {
            Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(false),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn microphone_permission(_stop: &mpsc::Receiver<Stop>) -> Result<bool, String> {
    Ok(true)
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    limit: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    failed: Arc<AtomicBool>,
    full: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let callback_failed = failed.clone();
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            let Ok(mut samples) = samples.try_lock() else {
                callback_failed.store(true, Ordering::Relaxed);
                return;
            };
            for frame in data.chunks_exact(channels) {
                if samples.len() >= limit {
                    full.store(true, Ordering::Relaxed);
                    break;
                }
                let mono = frame
                    .iter()
                    .map(|sample| sample.to_sample::<f32>())
                    .sum::<f32>()
                    / channels as f32;
                samples.push(if mono.is_finite() {
                    mono.clamp(-1.0, 1.0)
                } else {
                    0.0
                });
            }
        },
        move |_| {
            failed.store(true, Ordering::Relaxed);
        },
        None,
    )
}

fn resample(input: &[f32], rate: usize) -> Result<Vec<f32>, String> {
    if rate == OUTPUT_RATE {
        return Ok(input.to_vec());
    }
    let mut converter = FftFixedInOut::<f32>::new(rate, OUTPUT_RATE, 1024, 1)
        .map_err(|_| "无法转换录音采样率。")?;
    let delay = converter.output_delay();
    let frames = converter.input_frames_next();
    let needed = input.len() * OUTPUT_RATE / rate;
    let mut output = Vec::with_capacity(needed + delay + converter.output_frames_max());
    for chunk in input.chunks(frames) {
        let result = converter
            .process_partial(Some(&[chunk]), None)
            .map_err(|_| "无法转换录音采样率。")?;
        output.extend_from_slice(&result[0]);
    }
    while output.len() < needed + delay {
        let result = converter
            .process_partial::<&[f32]>(None, None)
            .map_err(|_| "无法转换录音采样率。")?;
        output.extend_from_slice(&result[0]);
    }
    Ok(output[delay..delay + needed].to_vec())
}

pub fn encode_wav(input: &[f32], rate: usize) -> Result<Vec<u8>, String> {
    let samples = resample(input, rate)?;
    let size = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(size as usize + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + size).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&(OUTPUT_RATE as u32).to_le_bytes());
    out.extend_from_slice(&(OUTPUT_RATE as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&size.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wav_is_mono_pcm16_with_correct_duration_at_device_rates() {
        for rate in [16_000, 44_100, 48_000] {
            let input = vec![0.25; rate];
            let wav = encode_wav(&input, rate).unwrap();
            assert_eq!(&wav[..4], b"RIFF");
            assert_eq!(&wav[8..12], b"WAVE");
            assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
            assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
            assert_eq!(wav.len(), 32_044);
            let center = i16::from_le_bytes(wav[16_044..16_046].try_into().unwrap());
            assert!((center - 8191).abs() < 10, "rate {rate}: {center}");
        }
    }
    #[test]
    fn pcm_clips_out_of_range_samples() {
        let wav = encode_wav(&[-2.0, 2.0], 16_000).unwrap();
        assert_eq!(&wav[44..], &[1, 128, 255, 127]);
    }
}
