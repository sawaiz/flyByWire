'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  PatchTracker,
  type GrayFrame,
  type Track,
} from '@/lib/external-tracker';
const API = 'http://127.0.0.1:8766';
type Sample = {
  elapsed_s: number;
  received_monotonic_s: number;
  media_time_s: number;
  selection_id: number;
  status: string;
  score: number;
  box: number[] | null;
  dx: number | null;
  dy: number | null;
};
type Capture = {
  run: string;
  id: string;
  recorder: MediaRecorder;
  chunks: Blob[];
  samples: Sample[];
  started: number;
  offset: number;
  uncertainty: number;
  width: number;
  height: number;
  camera: string;
  mediaStart: number;
  bytes: number;
};

export function ExternalCamera() {
  const video = useRef<HTMLVideoElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null),
    tracker = useRef(new PatchTracker());
  const gray = useRef<GrayFrame | null>(null),
    drag = useRef<{ x: number; y: number } | null>(null);
  const selection = useRef(0),
    dragEnd = useRef<{ x: number; y: number } | null>(null);
  const capture = useRef<Capture | null>(null),
    seen = useRef(new Set<string>());
  const clock = useRef<{ offset: number; uncertainty: number } | null>(null);
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [device, setDevice] = useState('');
  const [track, setTrack] = useState<Track>({
    status: 'unselected',
    box: null,
    score: 0,
    dx: null,
    dy: null,
  });
  const [recording, setRecording] = useState(false),
    [saved, setSaved] = useState('');
  const pendingSaves = useRef(new Map<string, Capture>());
  const retry = useRef<null | (() => Promise<void>)>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);

  async function syncClock() {
    const start = performance.now();
    const r = await fetch(API + '/api/external/clock', {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) throw Error('External camera clock unavailable');
    const value = (await r.json()) as { monotonic_s: number };
    const end = performance.now();
    clock.current = {
      offset: value.monotonic_s - (start + end) / 2000,
      uncertainty: (end - start) / 2,
    };
  }
  async function upload(c: Capture) {
    setSaved('Saving external video…');
    const base = API + '/api/external/' + c.run + '/' + c.id;
    const blob = new Blob(c.chunks, { type: c.recorder.mimeType });
    // Each artifact is immutable. A retry may encounter an already-saved half.
    const tracking = await fetch(base + '/tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        started_monotonic_s: c.started / 1000 + c.offset,
        clock_uncertainty_ms: c.uncertainty,
        media_time_at_start_s: c.mediaStart,
        width: c.width,
        height: c.height,
        camera: c.camera,
        samples: c.samples,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tracking.ok && tracking.status !== 409)
      throw Error(await tracking.text());
    const upload = await fetch(base + '/video', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
      signal: AbortSignal.timeout(30000),
    });
    if (!upload.ok && upload.status !== 409) throw Error(await upload.text());
    setSaved('Saved; preparing MP4…');
    pendingSaves.current.delete(c.id);
    if (!pendingSaves.current.size) retry.current = null;
    setRetryAvailable(pendingSaves.current.size > 0);
    for (let i = 0; i < 45; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const r = await fetch(base + '/status', {
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) throw Error('Cannot read external video status');
      const s = (await r.json()) as { status: string; error?: string };
      if (s.status === 'ready') {
        setSaved('External MP4 + track saved with trial');
        return;
      }
      if (s.status === 'error') {
        setSaved('Source video saved; MP4 conversion failed');
        setError(s.error || 'Conversion failed');
        return;
      }
    }
    setSaved('Source video saved; MP4 conversion pending');
  }
  function stopRecording() {
    if (capture.current?.recorder.state === 'recording')
      capture.current.recorder.stop();
  }
  function beginRecording(run: string) {
    if (
      !stream.current ||
      !video.current ||
      !clock.current ||
      !gray.current ||
      capture.current ||
      seen.current.has(run)
    )
      return;
    if (typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record webcam video');
      seen.current.add(run);
      return;
    }
    const mime = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(
      (t) => MediaRecorder.isTypeSupported(t),
    );
    if (!mime) {
      setError('No supported webcam recording format');
      seen.current.add(run);
      return;
    }
    const rec = new MediaRecorder(stream.current, {
      mimeType: mime,
      videoBitsPerSecond: 1800000,
    });
    const c: Capture = {
      run,
      id: crypto.randomUUID().replaceAll('-', ''),
      recorder: rec,
      chunks: [],
      samples: [],
      started: performance.now(),
      offset: clock.current.offset,
      uncertainty: clock.current.uncertainty,
      width: gray.current?.width || 320,
      height: gray.current?.height || 240,
      camera: stream.current.getVideoTracks()[0]?.label || 'Webcam',
      mediaStart: video.current.currentTime,
      bytes: 0,
    };
    rec.ondataavailable = (e) => {
      if (e.data.size) {
        c.chunks.push(e.data);
        c.bytes += e.data.size;
        if (c.bytes > 48 * 1024 * 1024) stopRecording();
      }
    };
    rec.onerror = () =>
      setError('Webcam recording failed; external evidence may be incomplete');
    rec.onstop = () => {
      capture.current = null;
      setRecording(false);
      pendingSaves.current.set(c.id, c);
      const save = async () => {
        try {
          await upload(c);
        } catch (e) {
          setError('External save failed: ' + String(e));
          setSaved('Recording retained in this tab');
          retry.current = async () => {
            for (const item of [...pendingSaves.current.values()]) {
              try {
                await upload(item);
              } catch (e) {
                setError('External save failed: ' + String(e));
              }
            }
            setRetryAvailable(pendingSaves.current.size > 0);
          };
          setRetryAvailable(true);
        }
      };
      void save();
    };
    try {
      rec.start(1000);
      capture.current = c;
      seen.current.add(run);
      setRecording(true);
      setSaved('Recording with trial');
    } catch (e) {
      setError(String(e));
    }
  }
  async function enable(selected?: string) {
    setBusy(true);
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error('Open localhost in a browser with camera support');
      stopRecording();
      gray.current = null;
      stream.current?.getTracks().forEach((t) => t.stop());
      const constraints = {
        audio: false,
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 20, max: 30 },
          ...(selected
            ? { deviceId: { exact: selected } }
            : { facingMode: 'user' }),
        },
      };
      let media = await navigator.mediaDevices.getUserMedia(constraints);
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'videoinput',
      );
      const builtIn = list.find((d) =>
        /facetime|macbook|built.in/i.test(d.label),
      );
      if (
        !selected &&
        builtIn &&
        media.getVideoTracks()[0].getSettings().deviceId !== builtIn.deviceId
      ) {
        media.getTracks().forEach((t) => t.stop());
        media = await navigator.mediaDevices.getUserMedia({
          ...constraints,
          video: {
            ...constraints.video,
            deviceId: { exact: builtIn.deviceId },
          },
        });
      }
      stream.current = media;
      setDevices(list);
      setDevice(media.getVideoTracks()[0].getSettings().deviceId || '');
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      tracker.current.clear();
      setEnabled(true);
      await syncClock();
      media.getVideoTracks()[0].onended = () => {
        stopRecording();
        setEnabled(false);
        tracker.current.clear();
        setError('Webcam disconnected');
      };
    } catch (e) {
      setError(String(e));
      if (!stream.current?.active) setEnabled(false);
    } finally {
      setBusy(false);
    }
  }
  function disable() {
    stopRecording();
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    tracker.current.clear();
    setEnabled(false);
    if (video.current) video.current.srcObject = null;
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }
  useEffect(
    () => () => {
      stopRecording();
      gray.current = null;
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(API + '/api/flight', {
          signal: AbortSignal.timeout(1500),
        });
        if (!r.ok) throw Error('Trial status unavailable');
        const f = (await r.json()) as { active: boolean; run_id?: string };
        if (active) {
          if (f.active && f.run_id && !capture.current) {
            if (!clock.current) await syncClock();
            // Defer recorder start so takeoff click / rAF are not blocked.
            const runId = f.run_id;
            window.setTimeout(() => beginRecording(runId), 0);
          }
          if (
            capture.current &&
            (!f.active ||
              f.run_id !== capture.current.run ||
              performance.now() - capture.current.started > 70000)
          )
            stopRecording();
        }
      } catch {
        if (active) {
          stopRecording();
          setSaved('Trial link lost; external recording stopped');
        }
      } finally {
        if (active) timer = setTimeout(() => void poll(), 400);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // References keep capture callbacks current without resetting the polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let frameId = 0;
    let last = 0;
    let lastVideoTime = -1;
    const trail: { x: number; y: number }[] = [];
    let lastUi = 0;
    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick);
      try {
        const v = video.current,
          c = canvas.current;
        if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
        // A long frame gap (takeoff / MediaRecorder hitch) must NOT permanently
        // kill the lock — skip this beat and let PatchTracker reacquire.
        if (now - last < 100 || v.currentTime === lastVideoTime) return;
        last = now;
        lastVideoTime = v.currentTime;
        c.width = 320;
        c.height = Math.round((v.videoHeight / v.videoWidth) * 320);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data,
          data = new Uint8Array(c.width * c.height);
        for (let i = 0; i < data.length; i++)
          data[i] =
            (pixels[i * 4] + pixels[i * 4 + 1] * 2 + pixels[i * 4 + 2]) / 4;
        gray.current = { width: c.width, height: c.height, data };
        const result = tracker.current.update(gray.current);
        // Throttle React updates; keep sample log at full tracker rate.
        if (now - lastUi > 150) {
          lastUi = now;
          setTrack(result);
        }
        if (result.box) {
          const b = result.box;
          trail.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
          if (trail.length > 80) trail.shift();
          ctx.strokeStyle = '#c8f28d';
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x, b.y, b.width, b.height);
          ctx.beginPath();
          trail.forEach((p, i) =>
            i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
          );
          ctx.stroke();
        } else trail.length = 0;
        if (drag.current) {
          ctx.strokeStyle = '#e8d995';
          const end = dragEnd.current || drag.current;
          ctx.strokeRect(
            drag.current.x,
            drag.current.y,
            end.x - drag.current.x,
            end.y - drag.current.y,
          );
        }
        const rec = capture.current;
        if (rec && rec.samples.length < 1800)
          rec.samples.push({
            elapsed_s: Math.max(0, (now - rec.started) / 1000),
            received_monotonic_s: now / 1000 + rec.offset,
            media_time_s: v.currentTime,
            selection_id: selection.current,
            status: result.status,
            score: result.score,
            box: result.box
              ? [result.box.x, result.box.y, result.box.width, result.box.height]
              : null,
            dx: result.dx,
            dy: result.dy,
          });
      } catch (e) {
        console.warn('external tracker frame failed', e);
      }
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [enabled]);
  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = e.currentTarget,
      r = c.getBoundingClientRect(),
      scale = Math.min(r.width / c.width, r.height / c.height);
    return {
      x: (e.clientX - r.left - (r.width - c.width * scale) / 2) / scale,
      y: (e.clientY - r.top - (r.height - c.height * scale) / 2) / scale,
    };
  }
  return (
    <section className="workspace-panel workspace-external">
      <div className="workspace-panel-heading">
        <h2>
          <Camera size={16} /> Laptop camera
        </h2>
        <div className="workspace-actions">
          {enabled && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                tracker.current.clear();
                setTrack({
                  status: 'unselected',
                  box: null,
                  score: 0,
                  dx: null,
                  dy: null,
                });
              }}
            >
              Reset target
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => (enabled ? disable() : void enable())}
          >
            {enabled ? 'Off' : busy ? 'Connecting…' : 'Enable'}
          </Button>
        </div>
      </div>
      <div className="external-surface">
        <video
          ref={video}
          muted
          playsInline
          className="external-source"
          aria-hidden="true"
        />
        <canvas
          ref={canvas}
          className="external-canvas"
          aria-label="External webcam tracking: drag a box around the drone"
          tabIndex={0}
          onPointerDown={(e) => {
            if (!enabled) return;
            drag.current = point(e);
            dragEnd.current = null;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current) dragEnd.current = point(e);
          }}
          onPointerUp={(e) => {
            const start = drag.current;
            drag.current = null;
            if (!start || !gray.current) return;
            const end = point(e);
            const selected = tracker.current.select(gray.current, {
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            });
            if (selected) selection.current += 1;
            setError(
              selected
                ? ''
                : 'Select a distinct drone-sized patch, at least 10 pixels wide.',
            );
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') tracker.current.clear();
          }}
        />
        {!enabled && (
          <div className="external-empty">
            <Camera size={28} />
            <p>Track from the laptop</p>
            <span>Enable the webcam, then drag a box around the drone.</span>
          </div>
        )}
      </div>
      <div className="external-status">
        <strong>
          {!enabled
            ? 'Webcam off'
            : track.status === 'tracking'
              ? `Tracking · Δx ${track.dx?.toFixed(0)} / Δy ${track.dy?.toFixed(0)} px`
              : track.status === 'lost'
                ? 'Target lost · reacquiring / select again'
                : 'Drag a box around the drone'}
        </strong>
        <span>
          {recording
            ? '● Recording external view'
            : saved || 'Image-plane tracking · observation only'}
        </span>
        {enabled && devices.length > 1 && (
          <select
            aria-label="Webcam device"
            value={device}
            disabled={recording}
            onChange={(e) => void enable(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Camera'}
              </option>
            ))}
          </select>
        )}
        {error && (
          <span role="alert" className="flight-error">
            {error}
          </span>
        )}
        {retryAvailable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void retry.current?.()}
          >
            Retry save
          </Button>
        )}
      </div>
    </section>
  );
}
