import { Show, createSignal, onCleanup } from "solid-js";

/**
 * Speech-to-text mic button using the browser's built-in Web Speech API
 * (`SpeechRecognition`) — no server round-trip, no cloud key. Clicking
 * toggles dictation; interim + final transcripts are streamed to the
 * parent via `onTranscript(text, isFinal)` so the composer can insert
 * text as you speak.
 *
 * The API is Chromium/Safari-only (`webkitSpeechRecognition`); on
 * unsupported browsers the button is hidden entirely rather than
 * rendering a dead control.
 */

// Minimal typings for the non-standard SpeechRecognition API.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSttSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export default function MicButton(props: {
  /** Called with each transcript chunk. `isFinal` marks a committed
   *  segment (safe to insert); interim chunks can be shown transiently. */
  onTranscript: (text: string, isFinal: boolean) => void;
  disabled?: boolean;
}) {
  const supported = isSttSupported();
  const [listening, setListening] = createSignal(false);
  let recog: SpeechRecognitionLike | null = null;

  function stop() {
    try {
      recog?.stop();
    } catch {
      // ignore
    }
    recog = null;
    setListening(false);
  }

  function start() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      // Emit only the newly-finalized text so we don't re-insert the
      // whole rolling transcript. Interim results are forwarded too so
      // the parent can show a live preview if it wants.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        const text = res[0]?.transcript ?? "";
        if (!text) continue;
        props.onTranscript(text, res.isFinal);
      }
    };
    r.onerror = () => stop();
    r.onend = () => {
      // Fires on stop() and also when the engine times out; reflect the
      // idle state so the icon stops pulsing.
      setListening(false);
      recog = null;
    };
    recog = r;
    try {
      r.start();
      setListening(true);
    } catch {
      stop();
    }
  }

  onCleanup(stop);

  return (
    <Show when={supported}>
      <button
        type="button"
        class="ag-btn ag-btn-ghost ag-btn-icon"
        classList={{ "!text-danger": listening() }}
        title={listening() ? "Stop dictation" : "Dictate (speech to text)"}
        aria-label={listening() ? "Stop dictation" : "Start dictation"}
        aria-pressed={listening()}
        disabled={props.disabled}
        onClick={() => (listening() ? stop() : start())}
        data-testid="chat-mic"
      >
        <Show when={listening()} fallback={<MicIcon />}>
          <span class="relative inline-flex">
            <MicIcon />
            <span class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
          </span>
        </Show>
      </button>
    </Show>
  );
}

function MicIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}
