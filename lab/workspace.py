"""Camera-first workspace. Observes video and runs experimental graded inference.
No UDP control socket or motor command path.
"""
import io,json,selectors,socket,subprocess,threading,time
from collections import deque
import numpy as np
from PIL import Image
from .core import ROOT,DATA

RECORDING=ROOT/'data/demo-default.mp4'
CHECKPOINT=ROOT/'experiments/active-quadratic-T4_T5.npz'
# Fallback if active checkpoint missing (first boot / fresh clone)
_LEGACY_CHECKPOINT=ROOT/'experiments/visual-fit-20260910T133833056081Z/quadratic-0-T4_T5.npz'
if not CHECKPOINT.exists() and _LEGACY_CHECKPOINT.exists():
    CHECKPOINT=_LEGACY_CHECKPOINT

class CameraFeed:
    def __init__(self):
        self.lock=threading.Lock();self.stop=threading.Event();self.mode='auto';self.retry=threading.Event()
        self.process=None;self.rgb=None;self.jpeg=None;self.seq=0;self.epoch=0;self.last=0
        self.source='connecting';self.detail='Looking for the drone';self.last_live_error=None;self.times=deque(maxlen=30)
        self.replay_until=0;self.flight_locked=False
        self.thread=threading.Thread(target=self.loop,daemon=True);self.thread.start()
    def set_mode(self,mode):
        with self.lock:
            if self.flight_locked: raise ValueError('Camera source is locked during the flight session')
            self.mode=mode
        self.replay_until=0;self.retry.set()
    def status(self):
        with self.lock:
            age=time.monotonic()-self.last if self.last else None
            return dict(mode=self.mode,source=self.source,detail=self.detail,sequence=self.seq,
                age_ms=round(age*1000) if age is not None else None,fresh=age is not None and age<1,
                fps=(len(self.times)-1)/(self.times[-1]-self.times[0]) if len(self.times)>1 and self.times[-1]>self.times[0] else 0,
                last_live_error=self.last_live_error,width=320,height=240)
    def snapshot(self):
        with self.lock:return self.rgb,self.jpeg,self.seq,self.epoch,self.last
    def reachable(self):
        try:
            with socket.create_connection(('192.168.1.1',7070),timeout=.35):return True
        except OSError:return False
    def loop(self):
        next_probe=0
        while not self.stop.is_set():
            with self.lock:mode=self.mode
            self.retry.clear()
            live=mode=='auto' and time.monotonic()>=self.replay_until and self.reachable()
            next_probe=time.monotonic()+15
            if not live and self.flight_locked:
                with self.lock:self.source='offline';self.detail='Live video lost during flight session'
                self.stop.wait(.2);continue
            if not live and not RECORDING.exists():
                with self.lock:self.source='offline';self.detail='Drone unavailable; no recording found'
                self.stop.wait(2);continue
            args=['ffmpeg','-nostdin','-v','error']
            if live:args+=['-rtsp_transport','udp','-timeout','3000000','-i','rtsp://192.168.1.1:7070/webcam','-vf','transpose=clock,fps=10,scale=320:240']
            else:args+=['-re','-i',str(RECORDING),'-vf','fps=10,scale=320:240']
            args+=['-pix_fmt','rgb24','-f','rawvideo','pipe:1']
            p=None;selector=None
            try:
                p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
                self.process=p;selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ)
                pending=bytearray();deadline=time.monotonic()+5
                with self.lock:self.epoch+=1;self.times.clear()
                while not self.stop.is_set() and p.poll() is None:
                    if self.retry.is_set():break
                    if not live and mode=='auto' and time.monotonic()>=next_probe:
                        next_probe=time.monotonic()+15
                        if self.reachable():break
                    if time.monotonic()>deadline:raise TimeoutError('Video frames stopped arriving')
                    if not selector.select(.2):continue
                    raw=p.stdout.read(65536)
                    if not raw:break
                    pending.extend(raw)
                    while len(pending)>=320*240*3:
                        frame=bytes(pending[:320*240*3]);del pending[:320*240*3]
                        rgb=np.frombuffer(frame,np.uint8).reshape(240,320,3)
                        output=io.BytesIO();Image.fromarray(rgb).save(output,format='JPEG',quality=85)
                        now=time.monotonic();deadline=now+3
                        with self.lock:
                            self.rgb=rgb;self.jpeg=output.getvalue();self.seq+=1;self.last=now;self.times.append(now)
                            self.source='live' if live else 'recording'
                            self.detail='Front camera · live' if live else 'Demo flight · replay (no live link)'
                            if live:self.last_live_error=None
                if live and not self.stop.is_set() and not self.retry.is_set():
                    with self.lock:self.last_live_error='Live stream unavailable; showing the recording'
            except Exception as exc:
                with self.lock:self.last_live_error=str(exc)
            finally:
                if selector:selector.close()
                if p:
                    if p.poll() is None:p.terminate()
                    try:p.wait(timeout=2)
                    except subprocess.TimeoutExpired:p.kill();p.wait()
                    if p.stdout:p.stdout.close()
                self.process=None
            # A failed live decoder must fall back even when its RTSP port is open.
            if live and not self.retry.is_set() and not self.stop.is_set():
                self.replay_until=time.monotonic()+15
                
            self.stop.wait(.15)
    def close(self):
        self.stop.set();self.retry.set();self.thread.join(timeout=4)

class Workspace:
    def __init__(self):
        self.feed=CameraFeed();self.stop=threading.Event();self.lock=threading.Lock()
        self.running=True;self.reset_requested=True;self.nodes=[];self.completed_at=None;self.telemetry=deque(maxlen=1000)
        self.frame=dict(ready=False,status='Loading brain',error=None,activity=[],motion=None,model_ms=0,
                        compute_ms=0,inference_sequence=0,source_age_ms=None,processed_frames=0,skipped_frames=0,history_span_ms=None)
        self.thread=threading.Thread(target=self.loop,daemon=True);self.thread.start()
    def state(self):
        with self.lock:
            result=dict(self.frame,running=self.running)
            result['result_age_ms']=(time.monotonic()-self.completed_at)*1000 if self.completed_at is not None and self.frame['status']=='Observing' else None
            result['observed_input_age_ms']=(result['source_age_ms']+result['result_age_ms']) if result['result_age_ms'] is not None else None
        result['camera']=self.feed.status()
        result['hardware_enabled']=False
        return result
    def loop(self):
        engine=None
        try:
            from .graded_engine import GradedEngine
            from .full_vision import RetinaEncoder
            from .motion_readout import MotionReadout
            meta=json.loads((DATA/'full-brain.json').read_text());self.nodes=meta['nodes']
            with np.load(DATA/'full-graded.npz') as f:graph={k:f[k] for k in f.files}
            bias=np.array([0 if n['type']=='R1-R6' else .5 for n in self.nodes],np.float32)
            engine=GradedEngine(graph,bias);encoder=RetinaEncoder();readout=MotionReadout(CHECKPOINT)
            baseline=engine.batch(np.zeros(len(bias),np.float32),200)
            with self.lock:self.frame.update(ready=True,manifest=meta['manifest'],adapter=dict(engine.adapter.info),status='Waiting for video')
            seen=0;epoch=-1;previous=None;previous_time=None;input_times=deque(maxlen=12)
            while not self.stop.is_set():
                rgb,_,seq,new_epoch,last=self.feed.snapshot()
                with self.lock:running=self.running;reset=self.reset_requested;self.reset_requested=False
                if reset or epoch!=new_epoch:
                    engine.reset(baseline);readout.reset();input_times.clear();epoch=new_epoch;previous=None;previous_time=None
                    with self.lock:
                        self.completed_at=None
                        self.frame.update(motion=None,activity=[],model_ms=0,history_span_ms=None)
                age=time.monotonic()-last
                if not running or rgb is None or age>1 or seq==seen:
                    if not running or age>1:
                        with self.lock:self.frame.update(status='Paused' if not running else 'Waiting for video',motion=None)
                    self.stop.wait(.025);continue
                small=np.asarray(Image.fromarray(rgb).resize((64,48)),np.float32)
                if (previous_time is not None and last-previous_time>.5) or (previous is not None and np.mean(np.abs(small-previous))>45):
                    engine.reset(baseline);readout.reset();input_times.clear()
                skipped=max(0,seq-seen-1) if previous_time is not None else 0
                previous=small;previous_time=last;seen=seq
                start=time.perf_counter();v=engine.batch(encoder.encode(small)/120,4)
                proposal=readout.update(v);input_times.append(last)
                history_span=(input_times[-1]-input_times[0])*1000 if proposal else None
                delta=np.abs(v-baseline);ids=np.flatnonzero(delta>1e-5)
                if len(ids)>6000:ids=ids[np.argpartition(delta[ids],-6000)[-6000:]]
                activity=np.column_stack([ids,np.minimum(3,delta[ids]/.02)]).tolist()
                with self.lock:
                    self.completed_at=time.monotonic()
                    self.frame.update(status='Observing',activity=activity,motion=proposal,
                    processed_frames=self.frame['processed_frames']+1,skipped_frames=self.frame['skipped_frames']+skipped,
                    model_ms=engine.tick*5,compute_ms=(time.perf_counter()-start)*1000,
                    inference_sequence=seq,source_age_ms=(time.monotonic()-last)*1000,history_span_ms=history_span,error=None)
                    self.telemetry.append(dict(sequence=seq,compute_ms=self.frame['compute_ms'],
                        receipt_to_completion_ms=self.frame['source_age_ms'],history_span_ms=history_span))
        except Exception as exc:
            with self.lock:self.frame.update(error=str(exc),status='Brain unavailable',motion=None)
        finally:
            if engine:engine.close()
    def timing_after(self,after):
        with self.lock:
            return dict(frames=[x for x in self.telemetry if x['sequence']>after],
                        possibly_truncated=len(self.telemetry)==1000 and after<self.telemetry[0]['sequence'])
    def command(self,action):
        if action in ['auto','recording']:
            self.feed.set_mode('auto' if action=='auto' else 'recording')
            with self.lock:self.reset_requested=True
        elif action in ['run','pause','reset']:
            with self.lock:
                if action!='reset':self.running=action=='run'
                if action!='pause':self.reset_requested=True
    def close(self):
        self.stop.set();self.feed.close();self.thread.join(timeout=5)

def validation_summary():
    path=ROOT/'experiments/quadratic-confirmation-20260910T134139278856Z/report.json'
    if not path.exists():return None
    r=json.loads(path.read_text())
    additional=ROOT/'benchmarks/camera-validation.json'
    return dict(additional_checks=json.loads(additional.read_text()) if additional.exists() else None,
                summary=r['summary'],phases=len(r['seeds']),clips_per_condition=len(r['seeds'])*2,
                description='Frozen decoder · synthetic gratings only',checkpoint=str(CHECKPOINT.relative_to(ROOT)))
