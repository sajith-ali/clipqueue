import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type Entry = { id: string; title: string; url: string };
type Info = {
  title: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  heights: number[];
  isPlaylist?: boolean;
  entries?: Entry[];
};
type Status =
  | "fetching"
  | "ready"
  | "choice"
  | "queued"
  | "downloading"
  | "merging"
  | "done"
  | "failed"
  | "error";
type Item = {
  id: number;
  url: string;
  status: Status;
  info?: Info;
  res: string;
  aud: string;
  prog: number;
  speed: string;
  eta: string;
  file?: string;
  err?: string;
  hint?: string;
  group?: string;
};
type Ev = {
  id: string;
  status: string;
  percent: number;
  speed: string;
  eta: string;
  file?: string;
  error?: string;
};
type Playlist = { title: string; entries: Entry[] };
type Settings = {
  dir: string | null;
  par: number;
  cookies: string;
  cookieFile: string | null;
  auto: boolean;
};

const DEF_SET: Settings = {
  dir: null,
  par: 2,
  cookies: "none",
  cookieFile: null,
  auto: true,
};
const AUD = ["M4A (AAC)", "MP3", "Opus", "WAV"];
const AFMT: Record<string, string> = {
  "M4A (AAC)": "m4a",
  MP3: "mp3",
  Opus: "opus",
  WAV: "wav",
};
const RES = [
  "Best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "Audio only",
];
const PILL: Record<Status, [string, string]> = {
  fetching: ["Reading", ""],
  ready: ["Ready", "ok"],
  choice: ["Needs your choice", "warn"],
  queued: ["Queued", ""],
  downloading: ["", "acc"],
  merging: ["Merging", "acc"],
  done: ["Done", "ok"],
  failed: ["Failed", "warn"],
  error: ["Link failed", "warn"],
};
const ICON: Record<string, string> = {
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  sliders:
    "M3 6h9M16 6h5M3 12h3M10 12h11M3 18h11M18 18h3M14 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM8 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM16 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  folder:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  close: "M6 6l12 12M18 6L6 18",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
};
const KEY = "clipqueue.v1",
  MAX_PLAYLIST = 100,
  PARALLEL_INFO = 3;
const N = (r: string) => parseInt(r);
const isGated = (u: string) => /facebook\.com|fb\.watch|instagram\.com/.test(u);
const SITES: Record<string, string> = {
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "facebook.com": "Facebook",
  "fb.watch": "Facebook",
  "instagram.com": "Instagram",
  "tiktok.com": "TikTok",
  "x.com": "X",
  "twitter.com": "X",
  "vimeo.com": "Vimeo",
};
const site = (u: string) => {
  try {
    const h = new URL(u).hostname.replace(/^(www|m|vm)\./, "");
    return SITES[h] ?? h;
  } catch {
    return "";
  }
};
const normUrl = (t: string) =>
  /^https?:\/\//i.test(t)
    ? t
    : /^(www\.|[\w-]+\.[a-z]{2,}\/)/i.test(t)
      ? "https://" + t
      : null;
const avail = (i: Item) => i.info!.heights.map((h) => h + "p");
const evalStatus = (i: Item): Status =>
  i.res === "Best" || i.res === "Audio only" || avail(i).includes(i.res)
    ? "ready"
    : "choice";
const box = (i: Item) =>
  (i.res === "Best" ? i.info!.heights[0] : N(i.res)) >= 1440 ? "mkv" : "mp4";
const fmt = (s?: number) =>
  s
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : "";
const busy = (s: Status) => ["queued", "downloading", "merging"].includes(s);

// Saved queue: restored on launch. Anything that was mid-download comes back as ready.
const norm = (i: Item): Item => {
  const status: Status = !i.info
    ? "fetching"
    : i.status === "done"
      ? "done"
      : evalStatus(i);
  return {
    ...i,
    status,
    speed: "",
    eta: "",
    err: undefined,
    prog: status === "done" ? 100 : 0,
  };
};
function load(): {
  items: Item[];
  def: { res: string; aud: string };
  settings: Settings;
} | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    return s
      ? {
          items: (s.items as Item[]).map(norm),
          def: s.def,
          settings: { ...DEF_SET, ...s.settings },
        }
      : null;
  } catch {
    return null;
  }
}
const saved = load();

const Icon = ({ n, s = 18 }: { n: string; s?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width={s}
    height={s}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={ICON[n]} />
  </svg>
);
const Seg = ({
  opts,
  val,
  on,
}: {
  opts: [string, string][];
  val: string;
  on: (v: string) => void;
}) => (
  <div className="seg" role="radiogroup">
    {opts.map(([v, l]) => (
      <button
        key={v}
        role="radio"
        aria-checked={val === v}
        className={val === v ? "on" : ""}
        onClick={() => on(v)}
      >
        {l}
      </button>
    ))}
  </div>
);
const Switch = ({
  on,
  set,
  label,
}: {
  on: boolean;
  set: (v: boolean) => void;
  label: string;
}) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    className={"switch" + (on ? " on" : "")}
    onClick={() => set(!on)}
  >
    <i />
  </button>
);

export default function App() {
  const [items, setItems] = useState<Item[]>(saved?.items ?? []);
  const [def, setDef] = useState(
    saved?.def ?? { res: "1080p", aud: "M4A (AAC)" },
  );
  const [settings, setSettings] = useState<Settings>(
    saved?.settings ?? DEF_SET,
  );
  const [showSet, setShowSet] = useState(false);
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState("");
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("clipqueue.theme") === "dark";
    } catch {
      return false;
    }
  });
  const [ver, setVer] = useState("");
  const [updating, setUpdating] = useState(false);
  const ref = useRef<Item[]>([]);
  ref.current = items;
  const waiters = useRef<Record<number, () => void>>({});
  const cancelled = useRef(new Set<number>());
  const nextId = useRef(Math.max(0, ...(saved?.items.map((i) => i.id) ?? [])));
  const known = useRef(new Set<string>(saved?.items.map((i) => i.url)));
  const active = useRef(0),
    jobs = useRef<(() => Promise<void>)[]>([]),
    updatingRef = useRef(false);

  const say = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 2800);
  };
  const patch = (id: number, p: Partial<Item>) =>
    setItems((xs) => xs.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const setSet = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }));
  // Cookies are only sent for login-gated sites (Facebook, Instagram), never for YouTube or anything else.
  const ck = (u: string) =>
    !isGated(u) || settings.cookies === "none"
      ? { cookieBrowser: null, cookieFile: null }
      : settings.cookies === "file"
        ? { cookieBrowser: null, cookieFile: settings.cookieFile }
        : { cookieBrowser: settings.cookies, cookieFile: null };
  const friendly = (e: string, u: string) =>
    /cookie database|DPAPI|decrypt|Could not copy/i.test(e)
      ? "Could not read cookies from that browser. Close it and retry, or use Firefox or a cookies.txt file."
      : isGated(u) &&
          /log ?in|cookies|private|authenticat|checkpoint|not available|unavailable|empty media response|rate-limit/i.test(
            e,
          )
        ? "This video looks private, removed or login-only. Pick a cookies source in Settings, then press Retry."
        : /Unsupported URL/i.test(e)
          ? "This link is not supported. Try the direct page of the video."
          : /Sign in to confirm|not a bot/i.test(e)
            ? "YouTube asked for a sign-in check. Update the engine in Settings and retry, or try again later."
            : /Private video|members-only|Join this channel/i.test(e)
              ? "This video is private or members-only."
              : /Video unavailable|has been removed|no longer available/i.test(
                    e,
                  )
                ? "This video is unavailable or was removed."
                : /429|Too Many Requests/i.test(e)
                  ? "Too many requests. Wait a few minutes and retry."
                  : /IP address is blocked|blocked from accessing/i.test(e)
                    ? "The site blocked this request. Update the engine or try again later."
                    : /getaddrinfo|Unable to download webpage|unreachable|timed out|Temporary failure/i.test(
                          e,
                        )
                      ? "Network problem. Check your connection and retry."
                      : /Requested format is not available/i.test(e)
                        ? "That quality is not available for this video. Pick another quality."
                        : /(ffmpeg|ffprobe).*(not found|not installed)|(not found|not installed).*(ffmpeg|ffprobe)/i.test(
                              e,
                            )
                          ? "ffmpeg is missing. Run get-engines.ps1 and rebuild."
                          : e;
  const refreshVer = () =>
    invoke<string>("engine_version")
      .then(setVer)
      .catch(() => setVer(""));
  async function updateEngine(silent = false) {
    if (running) return;
    updatingRef.current = true;
    setUpdating(true);
    try {
      const t = await invoke<string>("update_engine");
      if (/Updated yt-dlp/i.test(t)) say("Download engine updated");
      else if (!silent) say("Download engine is already up to date");
    } catch (e) {
      if (!silent) say("Update failed: " + String(e).slice(0, 90));
    }
    updatingRef.current = false;
    setUpdating(false);
    refreshVer();
    pump();
  }
  async function pickDir() {
    const d = await open({ directory: true, title: "Choose download folder" });
    if (typeof d === "string") setSet({ dir: d });
  }
  async function pickCookies() {
    const f = await open({
      filters: [{ name: "cookies.txt", extensions: ["txt"] }],
      title: "Choose cookies.txt",
    });
    if (typeof f === "string") setSet({ cookieFile: f });
  }

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("clipqueue.theme", dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);
  useEffect(() => {
    refreshVer();
    (async () => {
      if (settings.auto) await updateEngine(true);
      ref.current.filter((i) => !i.info).forEach((i) => loadInfo(i.id, i.url));
    })();
  }, []);
  // Ctrl+V anywhere outside a field adds the copied links.
  const addRef = useRef(addLinks);
  addRef.current = addLinks;
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest("input,select,textarea")) return;
      const s = e.clipboardData?.getData("text").trim();
      if (s) addRef.current(s);
    };
    window.addEventListener("paste", h);
    return () => window.removeEventListener("paste", h);
  }, []);
  useEffect(() => {
    if (!showSet) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSet(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [showSet]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ items, def, settings }));
      } catch {
        /* storage unavailable */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [items, def, settings]);
  useEffect(() => {
    const un = listen<Ev>("dl", ({ payload: p }) => {
      const id = Number(p.id),
        c = cancelled.current.has(id) && p.status === "failed";
      patch(id, {
        status: c ? "ready" : (p.status as Status),
        prog: c ? 0 : p.percent,
        speed: p.speed,
        eta: p.eta,
        file: p.file ?? undefined,
        err: c ? undefined : (p.error ?? undefined),
      });
      if (p.status === "done" || p.status === "failed") {
        waiters.current[id]?.();
        delete waiters.current[id];
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Info lookups run a few at a time so a 50-video playlist does not launch 50 yt-dlp processes at once.
  function pump() {
    while (
      active.current < PARALLEL_INFO &&
      jobs.current.length &&
      !updatingRef.current
    ) {
      active.current++;
      jobs.current.shift()!().finally(() => {
        active.current--;
        pump();
      });
    }
  }
  function loadInfo(id: number, u: string) {
    jobs.current.push(() =>
      invoke<Info>("fetch_info", { url: u, ...ck(u) })
        .then((info) => {
          if (info.isPlaylist && info.entries?.length) {
            // a profile, channel or multi-video post: expand it
            known.current.delete(u);
            setItems((xs) => xs.filter((i) => i.id !== id));
            let n = 0;
            for (const e of info.entries.slice(0, MAX_PLAYLIST))
              if (addOne(e.url, e.title, info.title)) n++;
            say(
              `Added ${n} video${n === 1 ? "" : "s"} from "${info.title}"` +
                (info.entries.length > MAX_PLAYLIST
                  ? ` (first ${MAX_PLAYLIST} only)`
                  : ""),
            );
            return;
          }
          setItems((xs) =>
            xs.map((i) => {
              if (i.id !== id) return i;
              const res = info.heights.length ? i.res : "Best"; // some sites report no resolutions
              return {
                ...i,
                info,
                res,
                status: evalStatus({ ...i, info, res }),
                err: undefined,
              };
            }),
          );
        })
        .catch((e) =>
          patch(id, { status: "error", err: friendly(String(e), u) }),
        ),
    );
    pump();
  }
  function addOne(u: string, hint?: string, group?: string) {
    if (known.current.has(u)) return false;
    known.current.add(u);
    const id = ++nextId.current;
    setItems((xs) => [
      ...xs,
      {
        id,
        url: u,
        status: "fetching",
        res: def.res,
        aud: def.aud,
        prog: 0,
        speed: "",
        eta: "",
        hint,
        group,
      },
    ]);
    loadInfo(id, u);
    return true;
  }
  async function addPlaylist(u: string) {
    say("Reading playlist...");
    try {
      const p = await invoke<Playlist>("fetch_playlist", { url: u });
      let n = 0;
      for (const e of p.entries.slice(0, MAX_PLAYLIST))
        if (addOne(e.url, e.title, p.title)) n++;
      say(
        `Added ${n} video${n === 1 ? "" : "s"} from "${p.title}"` +
          (p.entries.length > MAX_PLAYLIST
            ? ` (first ${MAX_PLAYLIST} only)`
            : ""),
      );
    } catch (e) {
      say("Could not read playlist: " + String(e).slice(0, 80));
    }
  }
  async function addLinks(text: string) {
    for (const raw of text.split(/\s+/).filter(Boolean)) {
      const u = normUrl(raw);
      if (!u) {
        say("That does not look like a link: " + raw.slice(0, 36));
        continue;
      }
      if (/youtube\.com\/playlist\?/.test(u)) {
        await addPlaylist(u);
        continue;
      }
      if (!addOne(u)) say("That link is already in the queue");
    }
  }

  async function runOne(id: number) {
    const it = ref.current.find((i) => i.id === id);
    if (!it || cancelled.current.has(id)) return;
    patch(id, { status: "downloading" });
    await new Promise<void>((done) => {
      waiters.current[id] = done;
      const audioOnly = it.res === "Audio only";
      invoke("start_download", {
        req: {
          id: String(id),
          url: it.url,
          height: it.res === "Best" || audioOnly ? null : N(it.res),
          audioOnly,
          audioFormat: AFMT[it.aud],
          container: box(it),
          outDir: settings.dir,
          ...ck(it.url),
        },
      }).catch((e) => {
        patch(id, { status: "failed", err: friendly(String(e), it.url) });
        done();
      });
    });
  }
  async function downloadAll() {
    const ids = ref.current
      .filter((i) => i.status === "ready" || i.status === "failed")
      .map((i) => i.id);
    const skip = ref.current.filter((i) => i.status === "choice").length;
    if (skip)
      say(
        `${skip} item${skip > 1 ? "s need" : " needs"} your choice and will be skipped`,
      );
    ids.forEach((id) => cancelled.current.delete(id));
    setItems((xs) =>
      xs.map((i) =>
        ids.includes(i.id)
          ? { ...i, status: "queued", err: undefined, prog: 0 }
          : i,
      ),
    );
    setRunning(true);
    let k = 0;
    const worker = async () => {
      while (k < ids.length) await runOne(ids[k++]);
    };
    await Promise.all(Array.from({ length: settings.par }, worker));
    setRunning(false);
  }
  function cancel(i: Item) {
    cancelled.current.add(i.id);
    if (i.status === "queued") patch(i.id, { status: "ready" });
    else invoke("cancel_download", { id: String(i.id) });
  }
  const choose = (i: Item, res: string) =>
    setItems((xs) =>
      xs.map((x) =>
        x.id === i.id ? { ...x, res, status: evalStatus({ ...x, res }) } : x,
      ),
    );
  const remove = (i: Item) => {
    known.current.delete(i.url);
    setItems((xs) => xs.filter((x) => x.id !== i.id));
  };
  const clearDone = () => {
    ref.current
      .filter((i) => i.status === "done")
      .forEach((i) => known.current.delete(i.url));
    setItems((xs) => xs.filter((i) => i.status !== "done"));
  };
  const move = (i: Item, d: number) =>
    setItems((xs) => {
      const k = xs.findIndex((x) => x.id === i.id),
        j = k + d;
      if (j < 0 || j >= xs.length) return xs;
      const c = [...xs];
      [c[k], c[j]] = [c[j], c[k]];
      return c;
    });
  const retryInfo = (i: Item) => {
    patch(i.id, { status: "fetching", err: undefined });
    loadInfo(i.id, i.url);
  };
  const submit = () => {
    addLinks(url);
    setUrl("");
  };
  const readyCount = items.filter(
    (i) => i.status === "ready" || i.status === "failed",
  ).length;
  const doneCount = items.filter((i) => i.status === "done").length;

  const Row = (i: Item) => {
    const hue = (i.id * 67) % 360,
      pill = PILL[i.status];
    const thumb = {
      background: i.info?.thumbnail
        ? `url(${i.info.thumbnail}) center/cover`
        : `linear-gradient(135deg,hsl(${hue} 80% 68%),hsl(${(hue + 55) % 360} 75% 58%))`,
    };
    const meta = [site(i.url), i.info?.uploader, i.group]
      .filter(Boolean)
      .join(" · ");
    if (!i.info)
      return (
        <div className="row" key={i.id}>
          <div className="thumb" style={thumb}>
            {i.status === "error" ? "!" : <span className="spin" />}
          </div>
          <div className="main">
            <div className="title">
              {i.hint ??
                (i.status === "error"
                  ? "Could not read this link"
                  : "Reading link")}
            </div>
            <div className="meta">
              {i.status === "error" ? i.url.slice(0, 80) : meta}
            </div>
            {i.err && <div className="err">{i.err}</div>}
          </div>
          <div className="side">
            <span className={"pill " + pill[1]}>{pill[0]}</span>
            {i.status === "error" && (
              <div className="acts on">
                <button className="text" onClick={() => retryInfo(i)}>
                  Retry
                </button>
                <button
                  className="ico"
                  aria-label="Remove"
                  onClick={() => remove(i)}
                >
                  <Icon n="close" s={16} />
                </button>
              </div>
            )}
          </div>
        </div>
      );
    const locked = busy(i.status) || i.status === "done",
      av = avail(i);
    const vl = Array.from(new Set(["Best", "Audio only", ...av, i.res]));
    const lo = av.find((r) => N(r) < N(i.res)),
      hi = [...av].reverse().find((r) => N(r) > N(i.res));
    return (
      <div
        className={"row" + (i.status === "choice" ? " choice" : "")}
        key={i.id}
      >
        <div className="thumb" style={thumb}>
          {i.info.duration ? <i>{fmt(i.info.duration)}</i> : null}
        </div>
        <div className="main">
          <div className="title">{i.info.title}</div>
          <div className="meta">{meta}</div>
          <div className="ctrl">
            <select
              className="menu"
              value={i.res}
              disabled={locked}
              aria-label="Video quality"
              onChange={(e) => choose(i, e.target.value)}
            >
              {vl.map((o) => (
                <option key={o} value={o}>
                  {o !== "Best" && o !== "Audio only" && !av.includes(o)
                    ? o + " (not available)"
                    : o}
                </option>
              ))}
            </select>
            <select
              className="menu"
              value={i.aud}
              disabled={locked || i.res !== "Audio only"}
              title="Used for Audio only downloads"
              aria-label="Audio encoding"
              onChange={(e) => patch(i.id, { aud: e.target.value })}
            >
              {AUD.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <span className="tag">
              {i.res === "Audio only"
                ? AFMT[i.aud].toUpperCase()
                : box(i).toUpperCase()}
            </span>
            {i.status === "done" && i.file && (
              <button
                className="text"
                onClick={() => invoke("reveal", { path: i.file })}
              >
                Show in folder
              </button>
            )}
          </div>
          {i.status === "choice" && (
            <div className="fix">
              {i.res} is not offered for this video. Pick what to download
              instead.
              <div>
                {lo && (
                  <button onClick={() => choose(i, lo)}>
                    Use {lo} (nearest lower)
                  </button>
                )}
                {hi && (
                  <button onClick={() => choose(i, hi)}>
                    Use {hi} (nearest higher)
                  </button>
                )}
                <button onClick={() => remove(i)}>Remove</button>
              </div>
            </div>
          )}
          {(i.status === "downloading" ||
            i.status === "merging" ||
            i.status === "done") && (
            <div className={"prog" + (i.status === "done" ? " ok" : "")}>
              <b style={{ width: i.prog + "%" }} />
            </div>
          )}
          {i.status === "downloading" && i.eta && (
            <div className="meta" style={{ marginTop: 4 }}>
              About {i.eta} left
            </div>
          )}
          {i.err && <div className="err">{i.err}</div>}
        </div>
        <div className="side">
          <span className={"pill " + pill[1]}>
            {i.status === "downloading"
              ? `${Math.round(i.prog)}%${i.speed ? " · " + i.speed : ""}`
              : pill[0]}
          </span>
          <div className={"acts" + (busy(i.status) ? " on" : "")}>
            {busy(i.status) ? (
              <button className="text" onClick={() => cancel(i)}>
                Cancel
              </button>
            ) : (
              <>
                <button
                  className="ico"
                  onClick={() => move(i, -1)}
                  aria-label="Move up"
                >
                  <Icon n="up" s={16} />
                </button>
                <button
                  className="ico"
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  <Icon n="down" s={16} />
                </button>
                <button
                  className="ico"
                  onClick={() => remove(i)}
                  aria-label="Remove"
                >
                  <Icon n="close" s={16} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="orbs" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <main className="app">
        <header className="nav">
          <div>
            <h1>ClipQueue</h1>
            <p className="sub">Any video link, one tidy queue</p>
          </div>
          <div className="navbtns">
            <button
              className="circle glass"
              onClick={() => setDark(!dark)}
              aria-label={
                dark ? "Switch to light theme" : "Switch to dark theme"
              }
            >
              <Icon n={dark ? "sun" : "moon"} />
            </button>
            <button
              className="circle glass"
              onClick={() => setShowSet(true)}
              aria-label="Settings"
            >
              <Icon n="sliders" />
            </button>
          </div>
        </header>
        <div className="field glass">
          <Icon n="link" s={20} />
          <input
            value={url}
            placeholder="Paste a video or playlist link"
            aria-label="Video link"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            onPaste={(e) => {
              const t = e.clipboardData.getData("text").trim();
              if (/\s/.test(t)) {
                e.preventDefault();
                addLinks(t);
              }
            }}
          />
          <button className="add" onClick={submit}>
            Add
          </button>
        </div>
        <div className="hintrow">
          <span>
            YouTube, TikTok, Instagram, Facebook and many more. Paste several
            links at once.
          </span>
          {doneCount > 0 && (
            <button className="text" onClick={clearDone}>
              Clear finished ({doneCount})
            </button>
          )}
        </div>
        {items.length ? (
          <section className="group glass" aria-label="Download queue">
            {items.map(Row)}
          </section>
        ) : (
          <div className="group glass empty">
            <div className="bigicon">
              <Icon n="download" s={30} />
            </div>
            <h2>No videos yet</h2>
            <p>
              Paste a link above, or press Ctrl+V anywhere in this window.
              Playlists, profiles and multi-video posts are added as separate
              items.
            </p>
          </div>
        )}
      </main>

      <footer className="dock glass">
        <label className="pillsel">
          <span>Video</span>
          <select
            className="menu"
            value={def.res}
            onChange={(e) => {
              const res = e.target.value;
              setDef({ ...def, res });
              setItems((xs) =>
                xs.map((i) =>
                  i.info && !busy(i.status) && i.status !== "done"
                    ? { ...i, res, status: evalStatus({ ...i, res }) }
                    : i,
                ),
              );
            }}
          >
            {RES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="pillsel">
          <span>Audio</span>
          <select
            className="menu"
            value={def.aud}
            onChange={(e) => setDef({ ...def, aud: e.target.value })}
          >
            {AUD.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button
          className="circle"
          aria-label="Open save folder"
          title="Open save folder"
          onClick={() => invoke("reveal", { path: null, dir: settings.dir })}
        >
          <Icon n="folder" />
        </button>
        <button
          className="cta"
          disabled={running || updating || !readyCount}
          onClick={downloadAll}
        >
          <Icon n="download" />
          {running
            ? "Downloading..."
            : "Download all" + (readyCount ? ` (${readyCount})` : "")}
        </button>
      </footer>

      {showSet && (
        <div className="backdrop" onClick={() => setShowSet(false)}>
          <div
            className="sheet glass"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-head">
              <span />
              <h2>Settings</h2>
              <button
                className="text strong"
                style={{ justifySelf: "end" }}
                autoFocus
                onClick={() => setShowSet(false)}
              >
                Done
              </button>
            </div>
            <div className="sheet-body">
              <h3 className="cap">Downloads</h3>
              <div className="list2">
                <div className="li">
                  <div className="lt">
                    Save folder
                    <small>
                      {settings.dir ?? "Downloads\\ClipQueue (default)"}
                    </small>
                  </div>
                  <div className="lr">
                    <button className="text" onClick={pickDir}>
                      Choose
                    </button>
                    {settings.dir && (
                      <button
                        className="text"
                        onClick={() => setSet({ dir: null })}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
                <div className="li">
                  <div className="lt">Downloads at once</div>
                  <Seg
                    opts={[
                      ["1", "1"],
                      ["2", "2"],
                      ["3", "3"],
                    ]}
                    val={String(settings.par)}
                    on={(v) => setSet({ par: Number(v) })}
                  />
                </div>
              </div>
              <p className="foot">
                Videos save as MP4, switching to MKV for 1440p and up.
              </p>

              <h3 className="cap">Download engine</h3>
              <div className="list2">
                <div className="li">
                  <div className="lt">
                    yt-dlp
                    <small>
                      {ver ? "Version " + ver : "Version not detected"}
                    </small>
                  </div>
                  <button
                    className="text"
                    disabled={updating || running}
                    onClick={() => updateEngine()}
                  >
                    {updating ? "Updating..." : "Check for update"}
                  </button>
                </div>
                <div className="li">
                  <div className="lt">
                    Update automatically
                    <small>Checks when the app starts</small>
                  </div>
                  <Switch
                    on={settings.auto}
                    set={(v) => setSet({ auto: v })}
                    label="Update automatically"
                  />
                </div>
              </div>
              <p className="foot">
                If a site stops working, updating the engine usually fixes it.
              </p>

              <h3 className="cap">Cookies for private videos</h3>
              <div className="list2">
                <div className="li">
                  <Seg
                    opts={[
                      ["none", "None"],
                      ["firefox", "Firefox"],
                      ["edge", "Edge"],
                      ["chrome", "Chrome"],
                      ["brave", "Brave"],
                      ["file", "File"],
                    ]}
                    val={settings.cookies}
                    on={(v) => setSet({ cookies: v })}
                  />
                </div>
                {settings.cookies === "file" && (
                  <div className="li">
                    <div className="lt">
                      cookies.txt
                      <small>{settings.cookieFile ?? "No file chosen"}</small>
                    </div>
                    <button className="text" onClick={pickCookies}>
                      Choose
                    </button>
                  </div>
                )}
              </div>
              <p className="foot">
                Only used for Facebook and Instagram, never for YouTube or other
                sites. Firefox is the most reliable; Chrome and Edge often block
                access while open. Only use your own account.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className={"toast glass" + (toast ? " on" : "")} role="status">
        {toast}
      </div>
    </>
  );
}
