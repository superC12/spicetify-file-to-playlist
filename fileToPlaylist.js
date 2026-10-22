// NAME: File to Playlist
// VERSION: 1.2.0
// DESCRIPTION: Turn a CSV or M3U file into a Spotify playlist. Drop the file onto Spotify, check the matches, create the playlist.

(function fileToPlaylist() {
	// Menu items are built with React, which Spicetify exposes a little after Menu
	if (!document.body || !window.Spicetify?.Menu || !Spicetify.React || !Spicetify.ReactJSX || !Spicetify.Platform) {
		setTimeout(fileToPlaylist, 300);
		return;
	}

	const ACCEPTED = /\.(csv|tsv|txt|m3u8?)$/i;
	const MAX_FILE_BYTES = 5 * 1024 * 1024;
	const SEARCH_CONCURRENCY = 3;
	const ADD_CHUNK = 100;
	const GOOD = 0.75; // score at or above this counts as a match
	const OKAY = 0.45; // between OKAY and GOOD the match is shown as "check this"

	// ---------------------------------------------------------------- parsing

	function parseCsvRows(text) {
		const firstLine = text.slice(0, text.search(/\r?\n|$/));
		const counts = { ",": 0, ";": 0, "\t": 0 };
		let quoted = false;
		for (const ch of firstLine) {
			if (ch === '"') quoted = !quoted;
			else if (!quoted && ch in counts) counts[ch]++;
		}
		const delimiter = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";

		const rows = [];
		let row = [];
		let field = "";
		let inQuotes = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (inQuotes) {
				if (ch === '"') {
					if (text[i + 1] === '"') {
						field += '"';
						i++;
					} else inQuotes = false;
				} else field += ch;
			} else if (ch === '"') inQuotes = true;
			else if (ch === delimiter) {
				row.push(field);
				field = "";
			} else if (ch === "\n" || ch === "\r") {
				if (ch === "\r" && text[i + 1] === "\n") i++;
				row.push(field);
				rows.push(row);
				row = [];
				field = "";
			} else field += ch;
		}
		if (field !== "" || row.length) {
			row.push(field);
			rows.push(row);
		}
		return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
	}

	const HEADERS = {
		title: ["title", "track name", "track title", "track", "song", "song name", "name"],
		artist: ["artist", "artists", "artist name", "artist name(s)", "artist names", "artist(s)", "performer"],
		album: ["album", "album name", "album title"],
		duration: ["duration", "duration (ms)", "duration_ms", "length", "time", "track duration (ms)"],
		uri: ["spotify uri", "track uri", "uri", "spotify url", "spotify link", "url", "link"],
		isrc: ["isrc"],
	};

	function parseDuration(value) {
		const v = String(value ?? "").trim();
		if (!v) return null;
		if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(v)) {
			return v.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
		}
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return null;
		return n > 10000 ? n : n * 1000; // milliseconds or seconds
	}

	function splitArtists(value) {
		return String(value ?? "")
			.split(/\s*;\s*|\s*,\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+/i)
			.map((a) => a.trim())
			.filter(Boolean);
	}

	function spotifyTrackUri(value) {
		const v = String(value ?? "").trim();
		const uri = v.match(/^spotify:track:([A-Za-z0-9]{22})$/);
		if (uri) return v;
		const url = v.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/);
		return url ? `spotify:track:${url[1]}` : null;
	}

	// "Artist - Title" split on the first " - ", since titles often contain dashes themselves
	function splitDisplay(text) {
		const s = String(text ?? "").trim();
		const at = s.indexOf(" - ");
		if (at === -1) return { artists: [], title: s };
		return { artists: splitArtists(s.slice(0, at)), title: s.slice(at + 3).trim() };
	}

	function parseCsv(text) {
		const rows = parseCsvRows(text);
		if (!rows.length) return [];
		const header = rows[0].map((h) => h.trim().toLowerCase());
		const col = {};
		for (const [key, names] of Object.entries(HEADERS)) {
			const index = header.findIndex((h) => names.includes(h));
			if (index !== -1) col[key] = index;
		}
		const hasHeader = col.title !== undefined || col.uri !== undefined;
		const body = hasHeader ? rows.slice(1) : rows;
		return body
			.map((r) => {
				if (!hasHeader) {
					// No recognisable header: "Title, Artist" columns, or a single "Artist - Title" column
					if (r.length === 1) return { ...splitDisplay(r[0]), album: "", duration: null, uri: spotifyTrackUri(r[0]) };
					return { title: r[0].trim(), artists: splitArtists(r[1]), album: (r[2] ?? "").trim(), duration: null, uri: null };
				}
				const get = (key) => (col[key] !== undefined ? (r[col[key]] ?? "").trim() : "");
				return {
					title: get("title"),
					artists: splitArtists(get("artist")),
					album: get("album"),
					duration: parseDuration(get("duration")),
					uri: spotifyTrackUri(get("uri")),
				};
			})
			.filter((t) => t.title || t.uri);
	}

	function parseM3u(text) {
		const tracks = [];
		let name = null;
		let pending = null;
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			if (line.startsWith("#PLAYLIST:")) {
				name = line.slice(10).trim() || null;
			} else if (line.startsWith("#EXTINF:")) {
				const body = line.slice(8);
				const comma = body.indexOf(",");
				const seconds = Number.parseFloat(body.slice(0, comma === -1 ? undefined : comma));
				pending = { ...splitDisplay(comma === -1 ? "" : body.slice(comma + 1)), duration: seconds > 0 ? seconds * 1000 : null };
			} else if (!line.startsWith("#")) {
				const uri = spotifyTrackUri(line);
				let entry = pending;
				if (!entry || (!entry.title && !uri)) {
					// No #EXTINF line: fall back to the file name, e.g. "Artist - Title.mp3"
					const file = decodeURIComponent(line.split(/[\\/]/).pop() ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
					entry = { ...splitDisplay(file), duration: entry?.duration ?? null };
				}
				tracks.push({ title: entry.title, artists: entry.artists, album: "", duration: entry.duration, uri });
				pending = null;
			}
		}
		return { name, tracks: tracks.filter((t) => t.title || t.uri) };
	}

	function parseFile(fileName, text) {
		const clean = text.replace(/^﻿/, "");
		const baseName = fileName.replace(/\.[^.]+$/, "");
		if (/\.m3u8?$/i.test(fileName) || clean.trimStart().startsWith("#EXTM3U")) {
			const { name, tracks } = parseM3u(clean);
			return { name: name ?? baseName, tracks };
		}
		return { name: baseName, tracks: parseCsv(clean) };
	}

	// --------------------------------------------------------------- matching

	function normalize(s) {
		return String(s ?? "")
			.normalize("NFKC")
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/g, "")
			.replace(/\s-\s(feat|ft)\.?\s.*$/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	}

	// Titles without the bracketed extras: "Black Betty (Single Edit)" -> "Black Betty"
	const coreTitle = (s) => normalize(String(s ?? "").replace(/\s*[([][^)\]]*[)\]]/g, "")) || normalize(s);

	function similarity(a, b) {
		if (!a || !b) return 0;
		if (a === b) return 1;
		if (a.includes(b) || b.includes(a)) return 0.85;
		const ta = new Set(a.split(" "));
		const tb = new Set(b.split(" "));
		const shared = [...ta].filter((t) => tb.has(t)).length;
		return shared / Math.max(ta.size, tb.size);
	}

	function score(track, candidate) {
		const title = Math.max(similarity(normalize(track.title), normalize(candidate.name)), similarity(coreTitle(track.title), coreTitle(candidate.name)) * 0.95);
		let artist = 0.5; // unknown artist neither helps nor hurts
		if (track.artists.length) {
			artist = 0;
			for (const wanted of track.artists) {
				for (const got of candidate.artists) artist = Math.max(artist, similarity(normalize(wanted), normalize(got)));
			}
		}
		let duration = 0.5;
		if (track.duration && candidate.duration) {
			const diff = Math.abs(track.duration - candidate.duration);
			duration = diff <= 3000 ? 1 : diff <= 10000 ? 0.6 : 0;
		}
		return title * 0.6 + artist * 0.3 + duration * 0.1;
	}

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const REQUEST_TIMEOUT = 8000;
	// A rate-limited request can hang instead of failing, which used to stall the whole list
	function withTimeout(promise) {
		let timer;
		return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("Search timed out")), REQUEST_TIMEOUT)))]).finally(() =>
			clearTimeout(timer)
		);
	}

	// Each search method is skipped once it has failed a few times in a row without ever working,
	// so a dead one doesn't slow down every song
	const health = { graphql: { ok: 0, failsInARow: 0 }, webapi: { ok: 0, failsInARow: 0 } };
	const resetHealth = () => Object.values(health).forEach((h) => (h.failsInARow = 0));
	const usable = (name) => health[name].ok > 0 || health[name].failsInARow < 3;
	async function tracked(name, run) {
		try {
			const result = await withTimeout(run());
			health[name].ok++;
			health[name].failsInARow = 0;
			return result;
		} catch (error) {
			health[name].failsInARow++;
			throw error;
		}
	}

	async function searchWebApi(query) {
		const url = `https://api.spotify.com/v1/search?type=track&limit=6&q=${encodeURIComponent(query)}`;
		for (let attempt = 1; attempt <= 2; attempt++) {
			let res;
			try {
				res = await withTimeout(Spicetify.CosmosAsync.get(url));
			} catch (error) {
				// CosmosAsync throws on error responses instead of returning them
				const code = Number(String(error?.message ?? error).match(/\b(429|5\d\d)\b/)?.[1]);
				res = { code: code || 0 };
			}
			if (res?.tracks?.items) {
				return res.tracks.items.map((t) => ({
					uri: t.uri,
					name: t.name,
					artists: (t.artists ?? []).map((a) => a.name),
					album: t.album?.name ?? "",
					duration: t.duration_ms ?? null,
				}));
			}
			if ((res?.code === 429 || res?.code >= 500) && attempt === 1) {
				await sleep(2000);
				continue;
			}
			throw new Error(`Search failed${res?.code ? ` (${res.code})` : ""}`);
		}
		throw new Error("Search rate-limited");
	}

	// Spotify's own track search. Since 1.3.5 its definition only loads once the Search page has been opened,
	// so if it isn't there yet, build it from the same class the other definitions use.
	const SEARCH_TRACKS_HASH = "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751";
	function searchDefinition() {
		const defs = Spicetify.GraphQL?.Definitions;
		if (!defs || !Spicetify.GraphQL.Request) return null;
		if (defs.searchTracks) return defs.searchTracks;
		const sample = Object.values(defs).find((d) => d && typeof d === "object" && "sha256Hash" in d);
		if (!sample) return null;
		try {
			return new sample.constructor("searchTracks", "query", SEARCH_TRACKS_HASH, null);
		} catch {
			return { ...sample, name: "searchTracks", operation: "query", sha256Hash: SEARCH_TRACKS_HASH, value: null };
		}
	}

	async function searchGraphQL(query) {
		const def = searchDefinition();
		if (!def) throw new Error("No GraphQL search available");
		const res = await Spicetify.GraphQL.Request(def, {
			searchTerm: query,
			offset: 0,
			limit: 6,
			numberOfTopResults: 6,
			includeAudiobooks: false,
		});
		if (res?.errors?.length && !res?.data) throw new Error(res.errors[0]?.message ?? "Search failed");
		const items = res?.data?.searchV2?.tracksV2?.items ?? [];
		return items
			.map((i) => i?.item?.data)
			.filter((d) => d?.uri)
			.map((d) => ({
				uri: d.uri,
				name: d.name,
				artists: (d.artists?.items ?? []).map((a) => a.profile?.name).filter(Boolean),
				album: d.albumOfTrack?.name ?? "",
				duration: d.duration?.totalMilliseconds ?? null,
			}));
	}

	// Spotify's own search first: the public Web API is heavily rate-limited for Spicetify. Fall back to it if needed.
	async function search(query) {
		let lastError = new Error("Search failed");
		if (searchDefinition() && usable("graphql")) {
			try {
				return await tracked("graphql", () => searchGraphQL(query));
			} catch (error) {
				console.warn("[File to Playlist] Spotify search failed", error);
				lastError = error;
			}
		}
		if (usable("webapi")) {
			try {
				return await tracked("webapi", () => searchWebApi(query));
			} catch (error) {
				console.warn("[File to Playlist] Web API search failed", error);
				lastError = error;
			}
		}
		throw lastError;
	}

	async function findMatches(track) {
		if (track.uri) return { status: "matched", candidates: [{ uri: track.uri, name: track.title || "Spotify link", artists: track.artists, album: "", duration: track.duration }], choice: 0 };
		const queries = [];
		if (track.artists.length) queries.push(`${coreTitle(track.title) || track.title} ${track.artists[0]}`);
		queries.push(track.title);

		const seen = new Map();
		for (const q of queries) {
			for (const c of await search(q)) if (!seen.has(c.uri)) seen.set(c.uri, { ...c, score: score(track, c) });
			const best = Math.max(0, ...[...seen.values()].map((c) => c.score));
			if (best >= GOOD) break;
		}
		const candidates = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 5);
		const best = candidates[0]?.score ?? 0;
		const status = best >= GOOD ? "matched" : best >= OKAY ? "check" : candidates.length ? "missing" : "none";
		return { status, candidates, choice: candidates.length ? 0 : -1 };
	}

	// --------------------------------------------------------------------- UI

	const style = document.createElement("style");
	style.textContent = `
		.plimp-backdrop { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }
		.plimp-dialog { display: flex; flex-direction: column; width: min(760px, calc(100vw - 48px)); max-height: calc(100vh - 96px); border-radius: 12px; background: var(--spice-main-elevated, #242424); color: var(--spice-text, #fff); box-shadow: 0 24px 64px rgba(0,0,0,.6); font-size: 14px; }
		.plimp-head { display: flex; align-items: center; gap: 12px; padding: 20px 24px 12px; }
		.plimp-head h1 { flex: 1; margin: 0; font-size: 22px; font-weight: 700; }
		.plimp-x { width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: var(--spice-subtext, #b3b3b3); font-size: 18px; cursor: pointer; }
		.plimp-x:hover { background: rgba(255,255,255,.1); color: var(--spice-text, #fff); }
		.plimp-body { flex: 1; overflow: auto; padding: 4px 24px 8px; }
		.plimp-foot { display: flex; align-items: center; gap: 12px; padding: 14px 24px 20px; border-top: 1px solid rgba(255,255,255,.08); }
		.plimp-foot .plimp-note { flex: 1; color: var(--spice-subtext, #b3b3b3); font-size: 13px; }
		.plimp-btn { padding: 10px 22px; border: 0; border-radius: 9999px; background: var(--spice-button, #1ed760); color: #000; font-size: 14px; font-weight: 700; cursor: pointer; }
		.plimp-btn:disabled { opacity: .45; cursor: default; }
		.plimp-btn.plimp-quiet { background: transparent; color: var(--spice-text, #fff); box-shadow: inset 0 0 0 1px rgba(255,255,255,.35); }
		.plimp-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 220px; margin: 8px 0 12px; border: 2px dashed rgba(255,255,255,.25); border-radius: 12px; text-align: center; cursor: pointer; }
		.plimp-drop.plimp-over, .plimp-drop:hover { border-color: var(--spice-button, #1ed760); background: rgba(255,255,255,.03); }
		.plimp-drop strong { font-size: 17px; }
		.plimp-muted { color: var(--spice-subtext, #b3b3b3); }
		.plimp-error { margin: 8px 0; color: #f15e6c; }
		.plimp-field { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 14px; }
		.plimp-field input[type=text] { padding: 10px 12px; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; background: rgba(0,0,0,.25); color: inherit; font-size: 15px; }
		.plimp-field input[type=text]:focus { outline: none; border-color: var(--spice-text, #fff); }
		.plimp-summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; }
		.plimp-chip { padding: 4px 10px; border-radius: 9999px; background: rgba(255,255,255,.08); font-size: 12px; font-weight: 600; }
		.plimp-progress { height: 4px; margin: 0 0 12px; border-radius: 2px; background: rgba(255,255,255,.1); overflow: hidden; }
		.plimp-progress > div { height: 100%; width: 0; background: var(--spice-button, #1ed760); transition: width .2s; }
		.plimp-list { display: flex; flex-direction: column; }
		.plimp-row { display: grid; grid-template-columns: 22px 20px minmax(0, 1fr) minmax(0, 1.2fr); gap: 10px; align-items: center; padding: 7px 4px; border-radius: 6px; }
		.plimp-row { cursor: pointer; user-select: none; }
		.plimp-row:hover { background: rgba(255,255,255,.04); }
		.plimp-tools { position: sticky; top: -4px; z-index: 1; display: flex; align-items: center; gap: 10px; margin: 0 -4px; padding: 6px 4px; background: var(--spice-main-elevated, #242424); border-bottom: 1px solid rgba(255,255,255,.08); }
		.plimp-all { display: flex; align-items: center; gap: 10px; padding: 0 0 0 4px; font-weight: 600; font-size: 13px; cursor: pointer; }
		.plimp-all input { width: 16px; height: 16px; accent-color: var(--spice-button, #1ed760); }
		.plimp-hint { flex: 1; color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
		.plimp-link { padding: 5px 10px; border: 0; border-radius: 9999px; background: rgba(255,255,255,.08); color: var(--spice-text, #fff); font-size: 12px; font-weight: 700; cursor: pointer; }
		.plimp-link:hover { background: rgba(255,255,255,.16); }
		.plimp-link:disabled { opacity: .4; cursor: default; }
		.plimp-link[hidden] { display: none; }
		.plimp-segs { display: inline-flex; gap: 4px; margin: 0 0 8px; padding: 3px; border-radius: 9999px; background: rgba(0,0,0,.25); }
		.plimp-seg { padding: 5px 14px; border: 0; border-radius: 9999px; background: transparent; color: var(--spice-subtext, #b3b3b3); font-size: 12px; font-weight: 700; cursor: pointer; }
		.plimp-seg.plimp-on { background: rgba(255,255,255,.14); color: var(--spice-text, #fff); }
		.plimp-text { box-sizing: border-box; width: 100%; min-height: 280px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; background: rgba(0,0,0,.25); color: inherit; font: 13px/1.5 ui-monospace, Consolas, monospace; resize: vertical; }
		.plimp-row.plimp-off { opacity: .5; }
		.plimp-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--spice-button, #1ed760); }
		.plimp-dot { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,.25); justify-self: center; }
		.plimp-dot.plimp-matched { background: #1ed760; }
		.plimp-dot.plimp-check { background: #f5a623; }
		.plimp-dot.plimp-missing, .plimp-dot.plimp-none, .plimp-dot.plimp-error { background: #f15e6c; }
		.plimp-src { min-width: 0; }
		.plimp-src div, .plimp-row select { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.plimp-src .plimp-t { font-weight: 600; }
		.plimp-src .plimp-a { color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
		.plimp-row select { width: 100%; padding: 6px 8px; border: 1px solid rgba(255,255,255,.15); border-radius: 6px; background: rgba(0,0,0,.25); color: inherit; font-size: 13px; }
		.plimp-legend { display: flex; gap: 14px; margin: 4px 0 8px; color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
		.plimp-legend span { display: inline-flex; align-items: center; gap: 6px; }
		.plimp-done { padding: 36px 0 24px; text-align: center; }
		.plimp-done strong { display: block; margin-bottom: 6px; font-size: 20px; }
		.plimp-toast { position: fixed; right: 24px; bottom: 110px; z-index: 10000; display: flex; align-items: center; gap: 10px; max-width: 420px; padding: 10px 16px 10px 12px; border-radius: 9999px; background: #2a2a2a; color: #fff; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,.5); pointer-events: none; animation: plimp-in .18s ease-out; }
		.plimp-toast-error { background: #3a1d20; }
		.plimp-spin { flex: 0 0 auto; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.25); border-top-color: var(--spice-button, #1ed760); border-radius: 50%; animation: plimp-rot .8s linear infinite; }
		.plimp-badge { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; color: #000; font-size: 12px; font-weight: 800; }
		.plimp-badge.plimp-ok { background: #1ed760; }
		.plimp-badge.plimp-error { background: #f15e6c; }
		@keyframes plimp-rot { to { transform: rotate(360deg); } }
		@keyframes plimp-in { from { opacity: 0; transform: translateY(8px); } }
		.plimp-dragglow { position: fixed; inset: 0; z-index: 9998; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.55); color: #fff; font-size: 22px; font-weight: 700; pointer-events: none; border: 3px dashed var(--spice-button, #1ed760); }
	`;
	document.head.appendChild(style);

	const h = (tag, props = {}, ...children) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === "class") el.className = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
		}
		for (const c of children.flat()) if (c != null && c !== false) el.append(c);
		return el;
	};
	const fmtTime = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "");
	const describe = (c) => `${c.name} — ${c.artists.join(", ")}${c.duration ? ` (${fmtTime(c.duration)})` : ""}`;

	let dialog = null;
	let cancelled = false;
	let reviewSession = 0; // bumps whenever a review is left, so its searches stop
	let keyHandler = null; // extra shortcuts for the screen that's showing

	function close() {
		cancelled = true;
		reviewSession++;
		keyHandler = null;
		dialog?.remove();
		dialog = null;
		document.removeEventListener("keydown", onKey, true);
	}
	function onKey(event) {
		if (event.key === "Escape") close();
		else keyHandler?.(event);
	}
	function show(box) {
		dialog?.replaceChildren(box);
	}

	async function copyText(text) {
		try {
			if (Spicetify.Platform?.ClipboardAPI?.copy) await Spicetify.Platform.ClipboardAPI.copy(text);
			else await navigator.clipboard.writeText(text);
			return true;
		} catch (error) {
			console.warn("[File to Playlist] copy failed", error);
			return false;
		}
	}

	function frame(title, body, foot) {
		const box = h("div", { class: "plimp-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
			h("div", { class: "plimp-head" }, h("h1", {}, title), h("button", { class: "plimp-x", "aria-label": "Close", onclick: close }, "✕")),
			h("div", { class: "plimp-body" }, body),
			foot ? h("div", { class: "plimp-foot" }, foot) : null
		);
		if (!dialog) {
			dialog = h("div", { class: "plimp-backdrop", onmousedown: (e) => e.target === dialog && close() });
			document.body.append(dialog);
			document.addEventListener("keydown", onKey, true);
		}
		dialog.replaceChildren(box);
		return box;
	}

	// Step 1: pick a file
	function showPicker(errorText) {
		cancelled = false;
		reviewSession++;
		keyHandler = null;
		const input = h("input", { type: "file", accept: ".csv,.tsv,.txt,.m3u,.m3u8", style: "display:none", onchange: () => input.files[0] && readFile(input.files[0]) });
		const drop = h("div", { class: "plimp-drop", tabindex: "0", onclick: () => input.click(), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && input.click() },
			h("strong", {}, "Drop a CSV or M3U file here"),
			h("div", { class: "plimp-muted" }, "or click to choose one"),
			input
		);
		drop.addEventListener("dragover", (e) => {
			e.preventDefault();
			drop.classList.add("plimp-over");
		});
		drop.addEventListener("dragleave", () => drop.classList.remove("plimp-over"));
		drop.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			drop.classList.remove("plimp-over");
			const file = e.dataTransfer?.files?.[0];
			if (file) readFile(file);
		});
		frame("Import a playlist", [
			errorText ? h("div", { class: "plimp-error" }, errorText) : null,
			drop,
			h("div", { class: "plimp-muted" }, "CSV files need a column for the song title, and ideally the artist. M3U playlists from other apps work as they are. Nothing is changed until you press Create."),
		]);
	}

	// Reads and parses a file. Resolves to { name, tracks }; rejects with a message meant for the user.
	function loadFile(file) {
		return new Promise((resolve, reject) => {
			if (!ACCEPTED.test(file.name)) return reject(new Error(`"${file.name}" isn't a CSV or M3U file.`));
			if (file.size > MAX_FILE_BYTES) return reject(new Error(`"${file.name}" is larger than 5 MB.`));
			const reader = new FileReader();
			reader.onload = () => {
				const result = parseFile(file.name, String(reader.result ?? ""));
				if (!result.tracks.length) reject(new Error(`No songs found in "${file.name}". Check that it has a title column.`));
				else resolve(result);
			};
			reader.onerror = () => reject(new Error(`"${file.name}" couldn't be read.`));
			reader.readAsText(file);
		});
	}

	function readFile(file) {
		loadFile(file).then(
			({ name, tracks }) => showReview(name, tracks),
			(error) => showPicker(error.message)
		);
	}

	// Small status pill in the bottom-right corner, used for files dropped onto Spotify
	let toast = null;
	let toastTimer = null;
	function status(text, kind = "busy", ms = 0) {
		clearTimeout(toastTimer);
		if (!toast) {
			toast = h("div", { class: "plimp-toast", role: "status", "aria-live": "polite" });
			document.body.append(toast);
		}
		const icon = kind === "busy" ? h("span", { class: "plimp-spin" }) : h("span", { class: `plimp-badge plimp-${kind}` }, kind === "ok" ? "✓" : "!");
		toast.replaceChildren(icon, h("span", {}, text));
		toast.className = `plimp-toast plimp-toast-${kind}`;
		if (ms) toastTimer = setTimeout(hideStatus, ms);
	}
	function hideStatus() {
		clearTimeout(toastTimer);
		toast?.remove();
		toast = null;
	}

	// Step 2: match every song, then let the user review
	const REASONS = { error: "Search failed", missing: "Not found", none: "Not found" };
	const leftoverReason = (row) => REASONS[row.status] ?? "Unticked";
	const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

	// Songs that won't go into the playlist, as a plain "Artist - Title" list or as a CSV that can be imported again
	function leftoversText(leftovers, format) {
		if (format === "csv") {
			return ["Title,Artist,Album,Reason", ...leftovers.map((r) => [r.track.title, r.track.artists.join(", "), r.track.album, leftoverReason(r)].map(csvCell).join(","))].join("\n");
		}
		return leftovers.map((r) => `${r.track.artists.length ? `${r.track.artists.join(", ")} - ` : ""}${r.track.title}`).join("\n");
	}

	// A page listing the songs that won't be added, ready to copy. `back` returns to the screen it was opened from.
	function showLeftovers(leftovers, back) {
		let format = "text";
		const text = h("textarea", { class: "plimp-text", readonly: true, spellcheck: "false", "aria-label": "Songs not added" });
		const textBtn = h("button", { class: "plimp-seg" }, "List");
		const csvBtn = h("button", { class: "plimp-seg" }, "CSV");
		const copyBtn = h("button", { class: "plimp-btn" }, "Copy to clipboard");
		const paint = () => {
			text.value = leftoversText(leftovers, format);
			textBtn.classList.toggle("plimp-on", format === "text");
			csvBtn.classList.toggle("plimp-on", format === "csv");
		};
		textBtn.addEventListener("click", () => ((format = "text"), paint()));
		csvBtn.addEventListener("click", () => ((format = "csv"), paint()));
		copyBtn.addEventListener("click", async () => {
			const ok = await copyText(text.value);
			copyBtn.textContent = ok ? "Copied" : "Couldn't copy";
			setTimeout(() => (copyBtn.textContent = "Copy to clipboard"), 1800);
		});
		const counts = {};
		for (const r of leftovers) counts[leftoverReason(r)] = (counts[leftoverReason(r)] ?? 0) + 1;
		const previousKeys = keyHandler;
		keyHandler = null;
		const box = frame("Songs not added", [
			h("div", { class: "plimp-summary" }, Object.entries(counts).map(([reason, n]) => h("span", { class: "plimp-chip" }, `${n} ${reason.toLowerCase()}`))),
			h("div", { class: "plimp-muted", style: "margin:0 0 10px" }, "Copy this list to look the songs up yourself, or save the CSV version and import it again later."),
			h("div", { class: "plimp-segs" }, textBtn, csvBtn),
			text,
		], [
			h("div", { class: "plimp-note" }, `${leftovers.length} song${leftovers.length === 1 ? "" : "s"}`),
			h("button", { class: "plimp-btn plimp-quiet", onclick: () => ((keyHandler = previousKeys), show(back)) }, "Back"),
			copyBtn,
		]);
		paint();
		return box;
	}

	function showReview(fileName, tracks) {
		cancelled = false;
		const session = ++reviewSession;
		resetHealth();
		const rows = tracks.map((track) => ({ track, status: "pending", candidates: [], choice: -1, include: false }));
		const nameInput = h("input", { type: "text", value: fileName, maxlength: "100", "aria-label": "Playlist name" });
		const dedupe = h("input", { type: "checkbox", checked: true });
		const bar = h("div");
		const summary = h("div", { class: "plimp-summary" });
		const list = h("div", { class: "plimp-list" });
		const createBtn = h("button", { class: "plimp-btn", disabled: true }, "Create playlist");
		const note = h("div", { class: "plimp-note" }, "Finding songs on Spotify…");
		const allBox = h("input", { type: "checkbox", "aria-label": "Select all" });
		const retryBtn = h("button", { class: "plimp-link", hidden: true }, "Retry failed");
		const leftBtn = h("button", { class: "plimp-link" }, "Songs not added");

		const selectable = (row) => row.candidates.length > 0;
		function setInclude(row, on) {
			if (!selectable(row)) return;
			if (on && row.choice < 0) row.choice = 0;
			row.include = on;
		}
		const leftovers = () => rows.filter((r) => r.status !== "pending" && !r.include);

		// Click a row (or its box) to tick it, Shift+click to tick or untick everything from the last clicked row,
		// Ctrl+click to toggle just that one
		let anchor = null;
		const rowEls = rows.map((row, i) => {
			const check = h("input", { type: "checkbox", tabindex: "-1", "aria-label": `Include ${row.track.title}` });
			const dot = h("span", { class: "plimp-dot", title: "Searching" });
			const select = h("select", { disabled: true, "aria-label": `Spotify match for ${row.track.title}` }, h("option", {}, "Searching…"));
			const el = h("div", { class: "plimp-row" }, check, dot,
				h("div", { class: "plimp-src" }, h("div", { class: "plimp-t", title: row.track.title }, row.track.title || "(no title)"), h("div", { class: "plimp-a" }, row.track.artists.join(", ") || "Unknown artist")),
				select
			);
			el.addEventListener("mousedown", (e) => e.shiftKey && e.preventDefault()); // no text selection on Shift+click
			el.addEventListener("click", (e) => {
				if (e.target.closest("select")) return;
				if (!selectable(row)) {
					if (e.target === check) e.preventDefault();
					return;
				}
				const on = e.target === check ? check.checked : !row.include;
				if (e.shiftKey && anchor !== null) {
					for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) setInclude(rows[k], on);
				} else setInclude(row, on);
				anchor = i;
				refresh();
			});
			select.addEventListener("change", () => {
				row.choice = Number(select.value);
				row.include = row.choice >= 0;
				refresh();
			});
			return { el, check, dot, select, index: i };
		});
		list.append(...rowEls.map((r) => r.el));

		function setAll(on) {
			for (const row of rows) setInclude(row, on);
			refresh();
		}
		allBox.addEventListener("change", () => setAll(allBox.checked));

		const LABELS = { matched: "Matched", check: "Check this match", missing: "Not found", none: "Not found", error: "Search failed" };
		function paintRow(i) {
			const row = rows[i];
			const r = rowEls[i];
			r.dot.className = `plimp-dot plimp-${row.status}`;
			r.dot.title = LABELS[row.status] ?? "Searching";
			r.check.checked = row.include;
			r.check.disabled = row.status !== "pending" && !selectable(row);
			r.el.classList.toggle("plimp-off", !row.include && row.status !== "pending");
			if (row.status === "pending") {
				if (r.select.dataset.state !== "pending") {
					r.select.replaceChildren(h("option", {}, "Searching…"));
					r.select.disabled = true;
					r.select.dataset.state = "pending";
				}
				return;
			}
			r.select.dataset.state = "";
			r.select.replaceChildren(
				...row.candidates.map((c, ci) => h("option", { value: String(ci), selected: ci === row.choice }, describe(c))),
				h("option", { value: "-1", selected: row.choice === -1 }, row.candidates.length ? "Don't add this song" : row.status === "error" ? `Search failed${row.error ? `: ${row.error}` : ""}` : "No match found")
			);
			r.select.disabled = !row.candidates.length;
		}

		function refresh() {
			const done = rows.filter((r) => r.status !== "pending").length;
			const count = (s) => rows.filter((r) => r.status === s || (s === "missing" && (r.status === "none" || r.status === "error"))).length;
			const chosen = rows.filter((r) => r.include).length;
			const failed = rows.filter((r) => r.status === "error").length;
			const pickable = rows.filter(selectable);
			const picked = pickable.filter((r) => r.include).length;
			bar.style.width = `${(done / rows.length) * 100}%`;
			summary.replaceChildren(
				h("span", { class: "plimp-chip" }, `${rows.length} songs in file`),
				h("span", { class: "plimp-chip" }, `${count("matched")} matched`),
				h("span", { class: "plimp-chip" }, `${count("check")} to check`),
				h("span", { class: "plimp-chip" }, `${count("missing")} not found`)
			);
			allBox.checked = pickable.length > 0 && picked === pickable.length;
			allBox.indeterminate = picked > 0 && picked < pickable.length;
			allBox.disabled = !pickable.length;
			retryBtn.hidden = !failed || done < rows.length;
			retryBtn.textContent = `Retry failed (${failed})`;
			const left = leftovers().length;
			leftBtn.textContent = `Songs not added (${left})`;
			leftBtn.disabled = !left;
			createBtn.textContent = `Create playlist (${chosen})`;
			createBtn.disabled = done < rows.length || chosen === 0 || !nameInput.value.trim();
			if (done === rows.length) note.textContent = "Amber songs are best guesses. Pick a different match from the list, or untick songs you don't want.";
			else note.textContent = `Finding songs on Spotify… ${done} of ${rows.length}`;
			rows.forEach((_, i) => paintRow(i));
		}
		nameInput.addEventListener("input", refresh);

		const reviewBox = frame("Import a playlist", [
			h("label", { class: "plimp-field" }, h("span", { class: "plimp-muted" }, "Playlist name"), nameInput),
			h("div", { class: "plimp-progress" }, bar),
			summary,
			h("div", { class: "plimp-legend" },
				h("span", {}, h("i", { class: "plimp-dot plimp-matched" }), "Matched"),
				h("span", {}, h("i", { class: "plimp-dot plimp-check" }), "Check this"),
				h("span", {}, h("i", { class: "plimp-dot plimp-missing" }), "Not found")
			),
			h("div", { class: "plimp-tools" },
				h("label", { class: "plimp-all" }, allBox, "Select all"),
				h("span", { class: "plimp-hint" }, "Shift+click for a range · Ctrl+A for all"),
				retryBtn,
				leftBtn
			),
			list,
		], [note, h("label", { class: "plimp-muted", style: "display:flex;gap:6px;align-items:center" }, dedupe, "Skip duplicates"), h("button", { class: "plimp-btn plimp-quiet", onclick: () => showPicker() }, "Back"), createBtn]);

		// Ctrl+A ticks everything, or unticks everything when it's all ticked already
		keyHandler = (e) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a" || e.target === nameInput) return;
			e.preventDefault();
			const pickable = rows.filter(selectable);
			setAll(!pickable.every((r) => r.include));
		};
		leftBtn.addEventListener("click", () => showLeftovers(leftovers(), reviewBox));
		refresh();

		createBtn.addEventListener("click", () => {
			const seen = new Set();
			const uris = [];
			for (const row of rows) {
				if (!row.include || row.choice < 0) continue;
				const uri = row.candidates[row.choice].uri;
				if (dedupe.checked && seen.has(uri)) continue;
				seen.add(uri);
				uris.push(uri);
			}
			createPlaylist(nameInput.value.trim(), uris, leftovers());
		});

		// Search a few songs at a time so Spotify doesn't rate-limit us
		const queue = rows.map((_, i) => i);
		let running = 0;
		const alive = () => !cancelled && session === reviewSession;
		async function worker() {
			running++;
			while (alive() && queue.length) {
				const row = rows[queue.shift()];
				try {
					const result = await findMatches(row.track);
					Object.assign(row, result, { include: result.status === "matched" || result.status === "check" });
				} catch (error) {
					console.warn("[File to Playlist] search failed", row.track, error);
					Object.assign(row, { status: "error", candidates: [], choice: -1, include: false, error: String(error?.message ?? error).replace(/^Search failed:? ?/, "") });
				}
				if (alive() && dialog) refresh();
			}
			running--;
		}
		const startWorkers = () => {
			while (running < SEARCH_CONCURRENCY && queue.length) worker();
		};
		retryBtn.addEventListener("click", () => {
			resetHealth();
			rows.forEach((row, i) => {
				if (row.status !== "error") return;
				row.status = "pending";
				queue.push(i);
			});
			refresh();
			startWorkers();
		});
		startWorkers();
	}

	// Step 3: create it
	async function createPlaylist(name, uris, leftovers = []) {
		keyHandler = null;
		frame("Import a playlist", h("div", { class: "plimp-done" }, h("strong", {}, "Creating your playlist…"), h("div", { class: "plimp-muted" }, `${uris.length} songs`)));
		try {
			const playlistUri = await Spicetify.Platform.RootlistAPI.createPlaylist(name, { before: "start" });
			if (!playlistUri) throw new Error("Spotify didn't return the new playlist");
			for (let i = 0; i < uris.length; i += ADD_CHUNK) {
				await Spicetify.Platform.PlaylistAPI.add(playlistUri, uris.slice(i, i + ADD_CHUNK), { after: "end" });
			}
			const id = playlistUri.split(":").pop();
			const doneBox = frame("Import a playlist",
				h("div", { class: "plimp-done" },
					h("strong", {}, `"${name}" is ready`),
					h("div", { class: "plimp-muted" }, `${uris.length} songs added.`),
					leftovers.length
						? h("button", { class: "plimp-link", style: "margin-top:10px", onclick: () => showLeftovers(leftovers, doneBox) }, `See the ${leftovers.length} song${leftovers.length === 1 ? "" : "s"} not added`)
						: null
				),
				[h("div", { class: "plimp-note" }), h("button", { class: "plimp-btn plimp-quiet", onclick: () => showPicker() }, "Import another"), h("button", { class: "plimp-btn", onclick: () => { close(); Spicetify.Platform.History.push(`/playlist/${id}`); } }, "Open playlist")]
			);
		} catch (error) {
			console.error("[File to Playlist] could not create playlist", error);
			frame("Import a playlist",
				h("div", { class: "plimp-done" }, h("strong", {}, "Couldn't create the playlist"), h("div", { class: "plimp-error" }, String(error?.message ?? error))),
				[h("div", { class: "plimp-note" }), h("button", { class: "plimp-btn", onclick: () => showPicker() }, "Start again")]
			);
		}
	}

	// ----------------------------------------------------------- entry points

	new Spicetify.Menu.Item("Import playlist from file", false, () => showPicker()).register();

	// Small public hook, handy for other extensions and for testing the parser
	window.FileToPlaylist = { open: () => showPicker(), parseFile };

	// Dropping a CSV or M3U anywhere on Spotify opens the importer with that file. The listeners run in the
	// capture phase so Spotify's own drag-and-drop handling can't swallow the drop first.
	let glow = null;
	let dragDepth = 0;
	const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
	const clearGlow = () => {
		dragDepth = 0;
		glow?.remove();
		glow = null;
	};
	window.addEventListener(
		"dragenter",
		(e) => {
			if (!hasFiles(e) || dialog) return;
			dragDepth++;
			if (!glow) {
				glow = h("div", { class: "plimp-dragglow" }, "Drop a CSV or M3U to import it as a playlist");
				document.body.append(glow);
			}
		},
		true
	);
	window.addEventListener(
		"dragleave",
		(e) => {
			if (!hasFiles(e) || dialog) return;
			if (--dragDepth <= 0) clearGlow();
		},
		true
	);
	window.addEventListener(
		"dragover",
		(e) => {
			if (hasFiles(e) && !dialog) e.preventDefault();
		},
		true
	);
	window.addEventListener("dragend", clearGlow, true);
	window.addEventListener(
		"drop",
		(e) => {
			const hadGlow = !!glow;
			clearGlow();
			const file = e.dataTransfer?.files?.[0];
			if (!file || dialog) return;
			if (!ACCEPTED.test(file.name)) {
				// Leave other files to Spotify, but say why nothing happened if this looked like an import attempt
				if (hadGlow) status(`"${file.name}" isn't a CSV or M3U file`, "error", 5000);
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			status(`Reading ${file.name}…`, "busy");
			loadFile(file).then(
				({ name, tracks }) => {
					status(`Found ${tracks.length} songs in ${file.name}`, "ok", 3000);
					showReview(name, tracks);
				},
				(error) => status(`Couldn't import: ${error.message}`, "error", 7000)
			);
		},
		true
	);
})();
