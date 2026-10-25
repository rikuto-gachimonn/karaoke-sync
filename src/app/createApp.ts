import { PositionPreviewController } from '../preview/controller';
import { BrowserPreviewTone } from '../preview/tone';
import { SimulatedPreviewPlayer } from '../preview/simulation';
import { createSimulation } from '../adapters/simulation';
import { SessionController } from '../session/controller';
import { DiagnosticLog } from '../diagnostics/log';
import { SustainedVolumeDetector } from '../domain/detector';
import { YouTubePlayer } from '../adapters/youtube/player';
import { BrowserAudioInput } from '../adapters/audio/microphone';
import { sessionOptions } from '../config/settings';
import { MeteredAudioInput } from '../calibration/meter';
import { CalibrationController } from '../calibration/controller';

export function createApp(mode: 'real' | 'simulation' = 'real', host: () => HTMLElement = () => document.getElementById('youtube-host')!) {
  const simulation = createSimulation();
  const log = new DiagnosticLog();
  const options = { ...sessionOptions };
  const diagnostic = (event: string, detail = '') => log.add(controller.getSnapshot().generation, event, detail);
  const dependencies = mode === 'simulation' ? simulation.dependencies : {
    createPlayer: () => new YouTubePlayer(host()),
    audio: { acquire: (signal?: AbortSignal) => {
      const generation = controller.getSnapshot().generation;
      return new BrowserAudioInput(undefined, (event, detail = '') => log.add(generation, event, detail)).acquire(signal);
    } },
    createDetector: () => new SustainedVolumeDetector(sample => diagnostic('detector.firstExceeded', JSON.stringify(sample))),
  };
  const meter = new MeteredAudioInput(dependencies.audio);
  let calibration: CalibrationController;
  let preview: PositionPreviewController;
  const controller = new SessionController({ ...dependencies, audio: meter, allowPrepare: () => !calibration?.getSnapshot().busy && !meter.busy && !preview?.getSnapshot().busy }, log, options);
  calibration = new CalibrationController(meter, () => controller.stop(), () => controller.getSnapshot().canPrepare && !preview?.getSnapshot().busy, diagnostic);
  preview = new PositionPreviewController({
    createPlayer: mode === 'simulation' ? () => new SimulatedPreviewPlayer() : dependencies.createPlayer,
    createTone: () => new BrowserPreviewTone(),
    canStart: () => controller.getSnapshot().canPrepare && !calibration.getSnapshot().busy && !meter.busy,
    hidden: () => document.hidden,
    onHidden: callback => { const changed = () => { if (document.hidden) callback(); }; document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); },
  });
  const stopAll = async () => { const endingPreview = preview.stop(); await calibration.cancel(); await controller.stop(); await endingPreview; };
  return { controller, preview, simulation, mode, meter, calibration, stopAll, setRetainMic: (value: boolean) => { if (controller.getSnapshot().canPrepare) options.retainMic = value; } };
}
export type AppServices = ReturnType<typeof createApp>;
