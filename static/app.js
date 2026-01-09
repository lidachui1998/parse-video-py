/* parse-video-py modern UI (no build step) */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    current: null,
    tab: "video",
    images: [],
    lightboxIndex: 0,
    lightboxMode: "img", // 'img' | 'video'
    busy: false,
  };

  const el = {
    html: document.documentElement,
    input: $("#shareText"),
    parseBtn: $("#parseBtn"),
    clearBtn: $("#clearBtn"),
    exampleBtn: $("#exampleBtn"),
    resultWrap: $("#resultWrap"),
    quickTitle: $("#quickTitle"),
    quickSubtitle: $("#quickSubtitle"),
    kv: $("#kv"),
    tabs: $("#tabs"),
    tabVideo: $("#tabVideo"),
    tabImages: $("#tabImages"),
    panelVideo: $("#panelVideo"),
    panelImages: $("#panelImages"),
    gallery: $("#gallery"),
    downloadAllBtn: $("#downloadAllBtn"),
    toastWrap: $("#toastWrap"),
    lightbox: $("#lightbox"),
    lbTitle: $("#lbTitle"),
    lbImg: $("#lbImg"),
    lbVideo: $("#lbVideo"),
    lbClose: $("#lbClose"),
    lbToggle: $("#lbToggle"),
    lbStage: $("#lbStage"),
    lbNavPrev: $("#lbNavPrev"),
    lbNavNext: $("#lbNavNext"),
    lbDlImg: $("#lbDlImg"),
    lbDlLive: $("#lbDlLive"),
    themeBtn: $("#themeBtn"),
    historyList: $("#historyList"),
    historyRefresh: $("#historyRefresh"),
    userChip: $("#userChip"),
    loginBtn: $("#loginBtn"),
    registerBtn: $("#registerBtn"),
    logoutBtn: $("#logoutBtn"),
  };

  function setBusy(v) {
    state.busy = v;
    el.parseBtn.disabled = v;
    el.clearBtn.disabled = v;
    el.exampleBtn.disabled = v;
    el.parseBtn.textContent = v ? "解析中…" : "解析";
  }

  function toast(type, title, message, timeoutMs = 2600) {
    const node = document.createElement("div");
    node.className = `toast ${type || ""}`.trim();
    node.innerHTML = `
      <div class="dot"></div>
      <div class="t">
        <b></b>
        <p></p>
      </div>
    `;
    node.querySelector("b").textContent = title || "";
    node.querySelector("p").textContent = message || "";
    el.toastWrap.appendChild(node);
    setTimeout(() => node.remove(), timeoutMs);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function downloadFromUrl(url, filename) {
    const res = await fetch(toProxy(url, guessReferer(url)), { mode: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    downloadBlob(blob, filename);
  }

  function extFromUrl(url, fallback) {
    const u = safeText(url).toLowerCase();
    const m = u.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/);
    if (m && m[1]) return m[1];
    return fallback || "bin";
  }

  function indexOfBytes(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function extractXmpFromJpegBytes(jpegBytes) {
    // Find XMP APP1 segment and return decoded XML string.
    // APP1 marker: FFE1, then length(2), then "http://ns.adobe.com/xap/1.0/\0"
    const XAP = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
    const bytes = jpegBytes;
    let i = 2; // after SOI
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker === 0xda) break; // SOS
      if (marker === 0xd9) break; // EOI
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (segLen < 2) break;
      const segStart = i + 4;
      const segEnd = i + 2 + segLen;
      if (marker === 0xe1 && segEnd <= bytes.length) {
        const seg = bytes.slice(segStart, segEnd);
        // check header
        let ok = true;
        for (let k = 0; k < XAP.length; k++) {
          if (seg[k] !== XAP[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          const xmlBytes = seg.slice(XAP.length);
          try {
            return new TextDecoder("utf-8", { fatal: false }).decode(xmlBytes);
          } catch {
            return new TextDecoder().decode(xmlBytes);
          }
        }
      }
      i = segEnd;
    }
    return "";
  }

  function parseXmpLengths(xmp) {
    const s = String(xmp || "");
    const getNum = (re) => {
      const m = s.match(re);
      return m && m[1] ? Number(m[1]) : 0;
    };
    return {
      hdrgmVersion: (s.match(/hdrgm:Version="([^"]+)"/) || [])[1] || "",
      tsUs: getNum(/GCamera:MotionPhotoPresentationTimestampUs="(\d+)"/),
      opVideoLen: getNum(/OpCamera:VideoLength="(\d+)"/),
      gainMapLen: getNum(/Item:Semantic="GainMap"[\s\S]*?Item:Length="(\d+)"/),
      motionLen: getNum(/Item:Semantic="MotionPhoto"[\s\S]*?Item:Length="(\d+)"/),
    };
  }

  function findJpegEoi(bytes) {
    // Prefer a JPEG-aware scan: find SOS, then locate the FIRST EOI marker in entropy-coded data.
    // This avoids false positives when a Motion Photo appends MP4 bytes after EOI (MP4 may contain 0xFF 0xD9).
    try {
      if (!bytes || bytes.length < 4) return -1;
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return -1;

      // Walk segments to find SOS
      let i = 2;
      while (i + 4 <= bytes.length) {
        if (bytes[i] !== 0xff) return -1;
        const marker = bytes[i + 1];
        // SOS
        if (marker === 0xda) {
          const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
          const scanStart = i + 2 + segLen;
          if (scanStart < 0 || scanStart >= bytes.length) return -1;

          // Scan entropy-coded stream for markers.
          for (let p = scanStart; p + 1 < bytes.length; p++) {
            if (bytes[p] !== 0xff) continue;
            const b = bytes[p + 1];
            if (b === 0x00) {
              // stuffed 0xFF byte
              p += 1;
              continue;
            }
            // Restart markers (FFD0..FFD7) can appear in scan data.
            if (b >= 0xd0 && b <= 0xd7) {
              p += 1;
              continue;
            }
            if (b === 0xd9) return p; // EOI
            // Other markers can appear; if so, just continue scanning.
          }
          return -1;
        }
        // EOI (shouldn't appear before SOS in valid JPEG)
        if (marker === 0xd9) return i;
        // Skip segment with length
        if (marker === 0xd8) {
          i += 2;
          continue;
        }
        if (i + 4 > bytes.length) return -1;
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        if (segLen < 2) return -1;
        i += 2 + segLen;
      }
    } catch {
      // fallthrough to naive scan
    }
    // Fallback: naive reverse scan
    for (let j = bytes.length - 2; j >= 0; j--) {
      if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) return j;
    }
    return -1;
  }

  function buildXmpApp1Segment(videoLength) {
    // OPPO/ColorOS uses Google Motion Photo Format + OpCamera fields.
    // Ref: https://blog.0to1.cf/posts/cn-motion-photo-format/
    // Although spec allows -1, some OEM galleries appear to require a non-negative timestamp.
    // Use a computed video timestamp when possible; fall back to 0.
    const ts = (videoLength && typeof videoLength.tsUs === "number" ? videoLength.tsUs : 0) || 0;
    const videoDataLength = videoLength && videoLength.dataLength ? videoLength.dataLength : (videoLength || 0);
    const videoContainerLength = videoLength && videoLength.containerLength ? videoLength.containerLength : (videoLength || 0);
    // Match OPPO XMP style closer: no xpacket wrappers.
    const xmp =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.0-jc003">\n` +
      `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
      `    <rdf:Description rdf:about=""\n` +
      `        xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"\n` +
      `        xmlns:OpCamera="http://ns.oplus.com/photos/1.0/camera/"\n` +
      `        xmlns:Container="http://ns.google.com/photos/1.0/container/"\n` +
      `        xmlns:Item="http://ns.google.com/photos/1.0/container/item/"\n` +
      `      GCamera:MotionPhoto="1"\n` +
      `      GCamera:MotionPhotoVersion="1"\n` +
      `      GCamera:MotionPhotoPresentationTimestampUs="${ts}"\n` +
      `      OpCamera:MotionPhotoPrimaryPresentationTimestampUs="${ts}"\n` +
      `      OpCamera:MotionPhotoOwner="oplus"\n` +
      `      OpCamera:OLivePhotoVersion="2"\n` +
      `      OpCamera:VideoLength="${videoDataLength || videoContainerLength}">\n` +
      `      <Container:Directory>\n` +
      `        <rdf:Seq>\n` +
      `          <rdf:li rdf:parseType="Resource">\n` +
      `            <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/>\n` +
      `          </rdf:li>\n` +
      `          <rdf:li rdf:parseType="Resource">\n` +
      `            <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoContainerLength}"/>\n` +
      `          </rdf:li>\n` +
      `        </rdf:Seq>\n` +
      `      </Container:Directory>\n` +
      `    </rdf:Description>\n` +
      `  </rdf:RDF>\n` +
      `</x:xmpmeta>\n`;

    const header = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
    const payload = new TextEncoder().encode(xmp);
    const body = new Uint8Array(header.length + payload.length);
    body.set(header, 0);
    body.set(payload, header.length);

    // APP1 length includes the 2 bytes of the length field itself
    const segLen = body.length + 2;
    const app1 = new Uint8Array(2 + 2 + body.length);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1[2] = (segLen >> 8) & 0xff;
    app1[3] = segLen & 0xff;
    app1.set(body, 4);
    return app1;
  }

  function parseMp4MdatPayloadLength(mp4Bytes) {
    // Minimal MP4 box parser to find 'mdat' payload length.
    // Returns 0 when unknown.
    const bytes = mp4Bytes;
    if (!bytes || bytes.length < 16) return 0;

    const readU32 = (off) =>
      ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    const readType = (off) =>
      String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

    let off = 0;
    while (off + 8 <= bytes.length) {
      let size = readU32(off);
      const type = readType(off + 4);
      let headerLen = 8;
      if (size === 1) {
        // 64-bit extended size
        if (off + 16 > bytes.length) break;
        headerLen = 16;
        // JS cannot represent uint64 precisely for huge files, but our live mp4 is small enough.
        const hi = readU32(off + 8);
        const lo = readU32(off + 12);
        size = hi * 4294967296 + lo;
      } else if (size === 0) {
        // box extends to EOF
        size = bytes.length - off;
      }

      if (size < headerLen) break;

      if (type === "mdat") {
        const payload = size - headerLen;
        const maxPayload = bytes.length - (off + headerLen);
        return Math.max(0, Math.min(payload, maxPayload));
      }

      off += size;
    }
    return 0;
  }

  function parseMp4DurationUs(mp4Bytes) {
    // Best-effort: read moov/mvhd duration.
    const bytes = mp4Bytes;
    if (!bytes || bytes.length < 32) return 0;
    const readU32 = (off) =>
      ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    const readType = (off) =>
      String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

    function readBox(off) {
      if (off + 8 > bytes.length) return null;
      let size = readU32(off);
      const type = readType(off + 4);
      let headerLen = 8;
      if (size === 1) {
        if (off + 16 > bytes.length) return null;
        headerLen = 16;
        const hi = readU32(off + 8);
        const lo = readU32(off + 12);
        size = hi * 4294967296 + lo;
      } else if (size === 0) {
        size = bytes.length - off;
      }
      if (size < headerLen) return null;
      return { off, type, size, headerLen, end: off + size };
    }

    // find moov
    let off = 0;
    let moov = null;
    while (off + 8 <= bytes.length) {
      const b = readBox(off);
      if (!b) break;
      if (b.type === "moov") {
        moov = b;
        break;
      }
      off += b.size;
    }
    if (!moov) return 0;

    // find mvhd inside moov (not fully recursive, but good enough for typical MP4)
    off = moov.off + moov.headerLen;
    while (off + 8 <= moov.end) {
      const b = readBox(off);
      if (!b || b.end > moov.end) break;
      if (b.type === "mvhd") {
        // FullBox: version(1) + flags(3)
        const p = b.off + b.headerLen;
        if (p + 24 > bytes.length) return 0;
        const version = bytes[p];
        if (version === 0) {
          const timescale = readU32(p + 12);
          const duration = readU32(p + 16);
          if (!timescale) return 0;
          return Math.floor((duration * 1_000_000) / timescale);
        }
        if (version === 1) {
          const timescale = readU32(p + 20);
          const hi = readU32(p + 24);
          const lo = readU32(p + 28);
          const duration = hi * 4294967296 + lo;
          if (!timescale) return 0;
          return Math.floor((duration * 1_000_000) / timescale);
        }
        return 0;
      }
      off += b.size;
    }
    return 0;
  }

  function insertApp1BeforeSos(jpegBytes, app1Segment) {
    // Insert APP1 XMP into JPEG header (before Start Of Scan), where metadata is normally stored.
    // JPEG structure: SOI (FFD8), then segments (FFxx + length), then SOS (FFDA) + image data.
    if (jpegBytes.length < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
      throw new Error("not a jpeg (missing SOI)");
    }
    let i = 2; // after SOI
    while (i + 4 <= jpegBytes.length) {
      if (jpegBytes[i] !== 0xff) {
        // corrupted marker; stop and insert here
        break;
      }
      // skip fill bytes 0xFF 0xFF...
      let marker = jpegBytes[i + 1];
      while (marker === 0xff && i + 2 < jpegBytes.length) {
        i++;
        marker = jpegBytes[i + 1];
      }
      const m = (0xff << 8) | marker;
      if (m === 0xffda) {
        // SOS - insert before it
        break;
      }
      // markers without length
      if (m === 0xffd9 || m === 0xffd8) break;
      // read segment length
      if (i + 4 > jpegBytes.length) break;
      const segLen = (jpegBytes[i + 2] << 8) | jpegBytes[i + 3];
      if (segLen < 2) break;
      i += 2 + segLen;
    }

    const out = new Uint8Array(jpegBytes.length + app1Segment.length);
    out.set(jpegBytes.slice(0, i), 0);
    out.set(app1Segment, i);
    out.set(jpegBytes.slice(i), i + app1Segment.length);
    return out;
  }

  function trimJpegToEoi(jpegBytes) {
    const eoi = findJpegEoi(jpegBytes);
    if (eoi < 0) throw new Error("JPEG 格式异常（未找到 EOI 标记）");
    return jpegBytes.slice(0, eoi + 2);
  }

  async function fetchBytesViaProxy(url) {
    const proxied = toProxy(url, guessReferer(url));
    const res = await fetch(proxied, { mode: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType: ct };
  }

  async function encodeProxyImageToJpegBytes(imageUrl) {
    // Convert any image (webp/png/...) to JPEG bytes using canvas (best-effort).
    const res = await fetch(toProxy(imageUrl, guessReferer(imageUrl)), { mode: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (typeof createImageBitmap === "undefined") {
      throw new Error("当前浏览器不支持图片转码（createImageBitmap 缺失）");
    }
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas not supported");
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const outBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("jpeg encode failed"))),
        "image/jpeg",
        0.92
      );
    });
    const buf = await outBlob.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function buildAndroidMotionPhotoJpg(imageUrl, liveVideoUrl) {
    const img = await fetchBytesViaProxy(imageUrl);
    const vid = await fetchBytesViaProxy(liveVideoUrl);

    let jpegBytes = img.bytes;
    if (!img.contentType.includes("jpeg") && !img.contentType.includes("jpg")) {
      // Some platforms return webp/png as images; convert to jpeg so Android Motion Photo can be recognized.
      jpegBytes = await encodeProxyImageToJpegBytes(imageUrl);
    }

    jpegBytes = trimJpegToEoi(jpegBytes);
    const mdatLen = parseMp4MdatPayloadLength(vid.bytes);
    const durUs = parseMp4DurationUs(vid.bytes);
    const tsUs = durUs ? Math.floor(durUs / 2) : 0;
    const app1 = buildXmpApp1Segment({
      containerLength: vid.bytes.length,
      dataLength: mdatLen || vid.bytes.length,
      tsUs,
    });
    const jpegWithXmp = insertApp1BeforeSos(jpegBytes, app1);

    // Final file: JPEG (with XMP) + MP4 bytes (must be last)
    const out = new Uint8Array(jpegWithXmp.length + vid.bytes.length);
    out.set(jpegWithXmp, 0);
    out.set(vid.bytes, jpegWithXmp.length);
    return out;
  }

  function normalizeUrlFromText(text) {
    const regex =
      /http[s]?:\/\/[\w.-]+[\w\/-]*[\w.-]*\??[\w=&:\-\+\%]*[/]*/;
    const m = String(text || "").match(regex);
    return m && m[0] ? m[0] : "";
  }

  function toProxy(url, referer) {
    const u = safeText(url);
    if (!u) return "";
    const params = new URLSearchParams({ url: u });
    if (referer) params.set("referer", referer);
    return `/proxy?${params.toString()}`;
  }

  function guessReferer(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/`;
    } catch {
      return "";
    }
  }

  function safeText(v) {
    if (v === null || v === undefined) return "";
    return String(v);
  }

  async function copyText(text) {
    const v = safeText(text);
    if (!v) return false;
    try {
      await navigator.clipboard.writeText(v);
      return true;
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = v;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        return true;
      } catch {
        return false;
      } finally {
        ta.remove();
      }
    }
  }

  function button(label, onClick, className) {
    const b = document.createElement("button");
    b.className = `btn ${className || ""}`.trim();
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function linkButton(label, url, opts = {}) {
    const a = document.createElement("a");
    a.className = `btn ${opts.className || ""}`.trim();
    a.href = url;
    a.target = opts.target || "_blank";
    a.rel = "noreferrer noopener";
    if (opts.download) a.download = opts.download;
    if (opts.referrerPolicy) a.referrerPolicy = opts.referrerPolicy;
    a.textContent = label;
    return a;
  }

  function setTab(tab) {
    state.tab = tab;
    el.tabVideo.classList.toggle("active", tab === "video");
    el.tabImages.classList.toggle("active", tab === "images");
    el.panelVideo.style.display = tab === "video" ? "" : "none";
    el.panelImages.style.display = tab === "images" ? "" : "none";
  }

  function renderKV(data) {
    el.kv.innerHTML = "";
    const rows = [
      ["标题", data.title],
      ["作者", data.author && (data.author.name || data.author.uid)],
      ["作者头像", data.author && data.author.avatar],
      ["封面", data.cover_url],
      ["视频", data.video_url],
      ["音乐", data.music_url],
      ["图集数量", Array.isArray(data.images) ? String(data.images.length) : ""],
    ];

    for (const [k, v] of rows) {
      if (!v) continue;
      const item = document.createElement("div");
      item.className = "item";
      const kk = document.createElement("div");
      kk.className = "k";
      kk.textContent = k;
      const vv = document.createElement("div");
      vv.className = "v";

      if (String(v).startsWith("http")) {
        // Many media URLs require Referer; provide a proxied open option for better compatibility.
        const shouldProxyOpen = ["作者头像", "封面", "视频", "音乐"].includes(k);
        if (shouldProxyOpen) {
          vv.appendChild(
            linkButton("打开(代理)", toProxy(v, guessReferer(v)), {
              className: "primary",
              target: "_blank",
            })
          );
          vv.appendChild(linkButton("打开原链接", v));
        } else {
          vv.appendChild(linkButton("打开链接", v, { className: "primary" }));
        }
        vv.appendChild(
          button("复制", async () => {
            const ok = await copyText(v);
            toast(ok ? "ok" : "error", ok ? "已复制" : "复制失败", k);
          }, "icon")
        );
      } else {
        vv.textContent = safeText(v);
      }

      item.appendChild(kk);
      item.appendChild(vv);
      el.kv.appendChild(item);
    }
  }

  function renderVideo(data) {
    el.panelVideo.innerHTML = "";

    const actionsRow = document.createElement("div");
    actionsRow.className = "row";

    if (data.cover_url) {
      actionsRow.appendChild(
        button("下载封面", async () => {
          try {
            await downloadFromUrl(data.cover_url, `cover.${extFromUrl(data.cover_url, "jpg")}`);
          } catch (e) {
            toast("error", "下载失败", safeText(e && e.message) || "未知错误", 3800);
          }
        })
      );
      actionsRow.appendChild(
        linkButton("打开封面(代理)", toProxy(data.cover_url, guessReferer(data.cover_url)), {
          className: "primary",
        })
      );
    }
    if (data.video_url) {
      actionsRow.appendChild(
        linkButton("打开视频链接", data.video_url, {
          className: "primary",
        })
      );
      actionsRow.appendChild(
        button("复制视频链接", async () => {
          const ok = await copyText(data.video_url);
          toast(ok ? "ok" : "error", ok ? "已复制" : "复制失败", "video_url");
        })
      );
    }
    if (data.music_url) {
      actionsRow.appendChild(linkButton("打开音乐", data.music_url));
    }
    actionsRow.appendChild(document.createElement("div")).className = "spacer";
    actionsRow.appendChild(
      button("复制 JSON", async () => {
        const ok = await copyText(JSON.stringify(data, null, 2));
        toast(ok ? "ok" : "error", ok ? "已复制" : "复制失败", "JSON");
      })
    );

    el.panelVideo.appendChild(actionsRow);

    if (data.video_url || data.cover_url) {
      const media = document.createElement("div");
      media.className = "media";

      if (data.video_url) {
        const v = document.createElement("video");
        v.controls = true;
        v.preload = "none";
        const ref = guessReferer(data.video_url);
        if (data.cover_url) v.poster = toProxy(data.cover_url, guessReferer(data.cover_url));
        v.src = toProxy(data.video_url, ref);
        media.appendChild(v);
      } else if (data.cover_url) {
        const img = document.createElement("img");
        img.src = toProxy(data.cover_url, guessReferer(data.cover_url));
        img.alt = "cover";
        media.appendChild(img);
      }

      el.panelVideo.appendChild(media);
    } else {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "没有可预览的视频/封面链接（有些字段可能为空）。";
      el.panelVideo.appendChild(p);
    }

    const tip = document.createElement("p");
    tip.className = "muted";
    tip.textContent =
      "提示：部分平台的资源链接可能需要特定 Referer，网页内预览可能失败；可用“打开链接/复制链接”在新标签页中尝试。";
    el.panelVideo.appendChild(tip);
  }

  function setLightboxMode(mode) {
    state.lightboxMode = mode;
    const item = state.images[state.lightboxIndex];
    const hasLive = !!(item && item.live_photo_url);

    // toggle button state
    if (hasLive) {
      el.lbToggle.style.display = "";
      el.lbToggle.textContent = mode === "img" ? "Live" : "图";
    } else {
      el.lbToggle.style.display = "none";
    }

    // actions visibility
    el.lbDlLive.style.display = hasLive ? "" : "none";

    // show/hide media
    if (mode === "video" && hasLive) {
      el.lbImg.style.display = "none";
      el.lbVideo.style.display = "";
      const videoUrl = item.live_photo_url;
      const proxied = toProxy(videoUrl, guessReferer(videoUrl));
      if (el.lbVideo.src !== proxied) {
        el.lbVideo.pause();
        el.lbVideo.src = proxied;
        el.lbVideo.load();
      }
      el.lbVideo.play().catch(() => {});
    } else {
      el.lbVideo.pause();
      el.lbVideo.removeAttribute("src");
      el.lbVideo.load();
      el.lbVideo.style.display = "none";
      el.lbImg.style.display = "";
    }
  }

  function openLightbox(idx) {
    state.lightboxIndex = idx;
    const item = state.images[idx];
    if (!item) return;
    el.lbTitle.textContent = `图片 ${idx + 1} / ${state.images.length}`;
    el.lbImg.src = toProxy(item.url, guessReferer(item.url));
    setLightboxMode("img");
    el.lightbox.classList.add("open");
  }

  function closeLightbox() {
    el.lightbox.classList.remove("open");
    el.lbImg.src = "";
    el.lbVideo.pause();
    el.lbVideo.removeAttribute("src");
    el.lbVideo.load();
    state.lightboxMode = "img";
  }

  function lightboxPrev() {
    if (!state.images.length) return;
    const next = (state.lightboxIndex - 1 + state.images.length) % state.images.length;
    openLightbox(next);
  }
  function lightboxNext() {
    if (!state.images.length) return;
    const next = (state.lightboxIndex + 1) % state.images.length;
    openLightbox(next);
  }

  function renderImages(data) {
    el.panelImages.innerHTML = "";
    state.images = Array.isArray(data.images) ? data.images : [];

    const row = document.createElement("div");
    row.className = "row";

    const countChip = document.createElement("div");
    countChip.className = "chip";
    countChip.textContent = `共 ${state.images.length} 张`;
    row.appendChild(countChip);

    row.appendChild(document.createElement("div")).className = "spacer";

    el.downloadAllBtn = button("打包下载（ZIP）", () => downloadAllImages(), "primary");
    el.downloadAllBtn.disabled = state.images.length === 0;
    row.appendChild(el.downloadAllBtn);

    el.panelImages.appendChild(row);

    if (state.images.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "这个链接没有解析出图集（如果是视频请切到“视频预览”）。";
      el.panelImages.appendChild(p);
      return;
    }

    const g = document.createElement("div");
    g.className = "gallery";

    state.images.forEach((item, idx) => {
      const t = document.createElement("div");
      t.className = "thumb";
      const media = document.createElement("div");
      media.className = "thumbMedia";

      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.src = toProxy(item.url, guessReferer(item.url));
      img.alt = `image-${idx + 1}`;
      media.appendChild(img);

      if (item.live_photo_url) {
        const badge = document.createElement("div");
        badge.className = "thumbBadge";
        badge.textContent = "Live";
        media.appendChild(badge);
      }

      const overlay = document.createElement("div");
      overlay.className = "thumbOverlay";

      const previewBtn = button("预览", (ev) => {
        ev.stopPropagation();
        openLightbox(idx);
      }, "mini primary");

      const dlImg = button(
        "图",
        async (ev) => {
          ev.stopPropagation();
          try {
            await downloadFromUrl(item.url, `image_${idx + 1}.${extFromUrl(item.url, "jpg")}`);
          } catch (e) {
            toast("error", "下载失败", safeText(e && e.message) || "未知错误", 3800);
          }
        },
        "mini"
      );

      overlay.appendChild(previewBtn);
      overlay.appendChild(dlImg);

      if (item.live_photo_url) {
        const dlLive = button(
          "Live",
          async (ev) => {
            ev.stopPropagation();
            try {
              await downloadFromUrl(item.live_photo_url, `live_${idx + 1}.mp4`);
            } catch (e) {
              toast("error", "下载失败", safeText(e && e.message) || "未知错误", 3800);
            }
          },
          "mini"
        );
        overlay.appendChild(dlLive);
      }

      media.appendChild(overlay);
      t.appendChild(media);

      // Click card to preview (overlay buttons already stopPropagation)
      t.addEventListener("click", () => openLightbox(idx));

      g.appendChild(t);
    });

    el.panelImages.appendChild(g);

    const extra = document.createElement("p");
    extra.className = "muted";
    extra.textContent =
      "提示：浏览器对跨域资源打包下载可能受 CORS 限制；若失败可逐张打开后保存。";
    el.panelImages.appendChild(extra);
  }

  async function downloadAllImages() {
    if (!state.images.length) return;
    if (typeof window.JSZip === "undefined" || typeof window.saveAs === "undefined") {
      toast(
        "error",
        "缺少依赖",
        "JSZip 或 FileSaver 未加载，请检查网络后刷新页面再试。"
      );
      return;
    }

    const zip = new window.JSZip();
    const folder = zip.folder("images");

    toast("ok", "开始打包", `共 ${state.images.length} 张图片（若跨域被拦截会失败）`, 2200);

    let ok = 0;
    let fail = 0;

    for (let i = 0; i < state.images.length; i++) {
      const url = state.images[i].url;
      try {
        const res = await fetch(toProxy(url, guessReferer(url)), { mode: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = guessExt(url, blob.type);
        folder.file(`image_${String(i + 1).padStart(3, "0")}.${ext}`, blob);
        ok++;
      } catch (e) {
        fail++;
      }
    }

    if (ok === 0) {
      toast("error", "打包失败", "全部图片都无法下载（可能是 CORS/403）。", 3800);
      return;
    }

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const base =
      (state.current && safeText(state.current.title).replace(/[^\w\s-]/g, "").trim()) ||
      "images";
    const name = `${base}_${Date.now()}.zip`;
    window.saveAs(blob, name);
    toast(
      fail ? "error" : "ok",
      "完成",
      `成功 ${ok} 张，失败 ${fail} 张（已生成 ZIP）`,
      4200
    );
  }

  function guessExt(url, mime) {
    const u = safeText(url).toLowerCase();
    if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "jpg";
    if (u.endsWith(".png")) return "png";
    if (u.endsWith(".webp")) return "webp";
    if (u.endsWith(".gif")) return "gif";
    if (mime && mime.includes("png")) return "png";
    if (mime && mime.includes("webp")) return "webp";
    if (mime && mime.includes("gif")) return "gif";
    return "jpg";
  }

  function render(data) {
    state.current = data;
    el.resultWrap.style.display = "";

    const title = safeText(data.title) || "已解析（标题为空）";
    el.quickTitle.textContent = title;

    const authorName = data.author && (data.author.name || data.author.uid);
    const hint = [];
    if (authorName) hint.push(`作者：${authorName}`);
    if (data.video_url) hint.push("类型：视频");
    if (Array.isArray(data.images) && data.images.length) hint.push(`图集：${data.images.length} 张`);
    el.quickSubtitle.textContent = hint.join(" · ") || "字段可能为空（不同平台返回不同）";

    const hasImages = Array.isArray(data.images) && data.images.length > 0;
    const hasVideo = !!data.video_url;

    renderKV(data);

    // If this is an album-only result, some platforms return a cover_url that is hotlink-blocked,
    // while the actual image URLs are accessible. Prefer the first image as cover preview.
    const videoData = hasImages && !hasVideo ? { ...data, cover_url: data.images[0].url } : data;

    renderVideo(videoData);
    renderImages(data);

    // Default tab: prefer album when there is no video.
    const defaultTab = hasVideo ? "video" : hasImages ? "images" : data.cover_url ? "video" : "images";
    setTab(defaultTab);
  }

  function fmtTime(s) {
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return safeText(s);
      return d.toLocaleString();
    } catch {
      return safeText(s);
    }
  }

  async function getMe() {
    try {
      const res = await fetch("/api/me");
      const json = await res.json();
      if (json && json.code === 200 && json.data) return json.data;
      return null;
    } catch {
      return null;
    }
  }

  async function loadHistory() {
    if (!el.historyList) return;
    el.historyList.textContent = "加载中…";
    try {
      const res = await fetch("/api/history?limit=50");
      const json = await res.json();
      if (!json || json.code === 401 || res.status === 401) {
        el.historyList.innerHTML =
          `<div class="muted">登录后才会记录历史。你可以先 <a href="/login">登录</a> 或 <a href="/register">注册</a>。</div>`;
        return;
      }
      if (!json || json.code !== 200) throw new Error((json && json.msg) || `HTTP ${res.status}`);
      const items = json.data || [];
      if (!items.length) {
        el.historyList.innerHTML = `<div class="muted">暂无历史记录。</div>`;
        return;
      }
      el.historyList.innerHTML = "";
      for (const it of items) {
        const node = document.createElement("div");
        node.className = "historyItem";
        const left = document.createElement("div");
        left.className = "left";
        const t = document.createElement("div");
        t.className = "t";
        t.textContent = it.title || it.share_url || `记录 #${it.id}`;
        const m = document.createElement("div");
        m.className = "m";
        m.innerHTML = "";
        const meta = document.createElement("span");
        meta.textContent = `${fmtTime(it.created_at)} · ${it.kind || ""}`.trim();
        const url = document.createElement("span");
        url.className = "mono";
        url.style.opacity = "0.95";
        url.style.maxWidth = "100%";
        url.style.whiteSpace = "nowrap";
        url.style.overflow = "hidden";
        url.style.textOverflow = "ellipsis";
        url.textContent = it.share_url || "";
        m.appendChild(meta);
        if (it.share_url) m.appendChild(url);
        left.appendChild(t);
        left.appendChild(m);

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "8px";
        right.style.alignItems = "center";

        right.appendChild(
          button(
            "查看",
            async () => {
              try {
                const r = await fetch(`/api/history/${it.id}`);
                const j = await r.json();
                if (!j || j.code !== 200) throw new Error((j && j.msg) || `HTTP ${r.status}`);
                if (j.data && j.data.data) render(j.data.data);
              } catch (e) {
                toast("error", "打开失败", safeText(e && e.message) || "未知错误", 4200);
              }
            },
            "mini primary"
          )
        );
        right.appendChild(
          button(
            "删除",
            async () => {
              try {
                const r = await fetch(`/api/history/${it.id}`, { method: "DELETE" });
                const j = await r.json();
                if (!j || (j.code !== 200 && j.code !== 404)) throw new Error((j && j.msg) || `HTTP ${r.status}`);
                await loadHistory();
              } catch (e) {
                toast("error", "删除失败", safeText(e && e.message) || "未知错误", 4200);
              }
            },
            "mini"
          )
        );

        node.appendChild(left);
        node.appendChild(right);
        el.historyList.appendChild(node);
      }
    } catch (e) {
      el.historyList.innerHTML = `<div class="muted">加载失败：${safeText(e && e.message) || "未知错误"}</div>`;
    }
  }

  async function parse() {
    const raw = safeText(el.input.value).trim();
    if (!raw) {
      toast("error", "请输入链接", "请粘贴分享文案或 URL。");
      el.input.focus();
      return;
    }

    const url = normalizeUrlFromText(raw);
    if (!url) {
      toast("error", "没有识别到 URL", "请确认文本里包含 http(s) 链接。");
      el.input.focus();
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/video/share/url/parse?url=${encodeURIComponent(raw)}`);
      const json = await res.json();
      if (json && json.code === 200 && json.data) {
        render(json.data);
        loadHistory().catch(() => {});
      } else {
        toast("error", "解析失败", safeText(json && json.msg) || "未知错误", 4200);
      }
    } catch (e) {
      toast("error", "请求失败", safeText(e && e.message) || "网络错误", 4200);
    } finally {
      setBusy(false);
    }
  }

  function setTheme(theme) {
    // theme: 'system' | 'dark' | 'light'
    if (theme === "system") {
      el.html.removeAttribute("data-theme");
    } else {
      el.html.setAttribute("data-theme", theme);
    }
    localStorage.setItem("pv_theme", theme);

    // update button label
    if (theme === "dark") el.themeBtn.textContent = "☾";
    else if (theme === "light") el.themeBtn.textContent = "☀";
    else el.themeBtn.textContent = "◐";
  }

  function toggleTheme() {
    const cur = localStorage.getItem("pv_theme") || "system";
    const next = cur === "system" ? "dark" : cur === "dark" ? "light" : "system";
    setTheme(next);
  }

  // events
  el.parseBtn.addEventListener("click", parse);
  el.clearBtn.addEventListener("click", () => {
    el.input.value = "";
    el.input.focus();
  });
  el.exampleBtn.addEventListener("click", () => {
    el.input.value =
      "复制任意平台分享文案/链接粘贴到这里，例如：\nhttps://v.douyin.com/xxxxxx/";
    el.input.focus();
  });
  el.input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") parse();
  });

  el.tabVideo.addEventListener("click", () => setTab("video"));
  el.tabImages.addEventListener("click", () => setTab("images"));

  el.lbClose.addEventListener("click", closeLightbox);
  el.lbNavPrev.addEventListener("click", (e) => {
    e.stopPropagation();
    lightboxPrev();
  });
  el.lbNavNext.addEventListener("click", (e) => {
    e.stopPropagation();
    lightboxNext();
  });
  el.lbToggle.addEventListener("click", () => {
    const item = state.images[state.lightboxIndex];
    if (!item || !item.live_photo_url) return;
    setLightboxMode(state.lightboxMode === "img" ? "video" : "img");
  });

  // Lightbox download / synth
  el.lbDlImg.addEventListener("click", async (e) => {
    e.stopPropagation();
    const item = state.images[state.lightboxIndex];
    if (!item) return;
    try {
      await downloadFromUrl(item.url, `image_${state.lightboxIndex + 1}.${extFromUrl(item.url, "jpg")}`);
    } catch (err) {
      toast("error", "下载失败", safeText(err && err.message) || "未知错误", 3800);
    }
  });
  el.lbDlLive.addEventListener("click", async (e) => {
    e.stopPropagation();
    const item = state.images[state.lightboxIndex];
    if (!item || !item.live_photo_url) return;
    try {
      await downloadFromUrl(item.live_photo_url, `live_${state.lightboxIndex + 1}.mp4`);
    } catch (err) {
      toast("error", "下载失败", safeText(err && err.message) || "未知错误", 3800);
    }
  });
  el.lightbox.addEventListener("click", (e) => {
    if (e.target === el.lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (!el.lightbox.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") lightboxPrev();
    if (e.key === "ArrowRight") lightboxNext();
  });

  // swipe gestures for mobile (left/right to navigate) - bind to the stage (preview area).
  let touchX = 0;
  let touchY = 0;
  let swiping = false;
  const SWIPE_MIN = 46;
  const SWIPE_LOCK = 10;
  const SWIPE_MAX_Y = 90;

  el.lbStage.addEventListener(
    "touchstart",
    (e) => {
      if (!el.lightbox.classList.contains("open")) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      swiping = false;
      touchX = t.clientX;
      touchY = t.clientY;
    },
    { passive: true, capture: true }
  );

  el.lbStage.addEventListener(
    "touchmove",
    (e) => {
      if (!el.lightbox.classList.contains("open")) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      const dx = t.clientX - touchX;
      const dy = t.clientY - touchY;
      if (Math.abs(dx) > SWIPE_LOCK && Math.abs(dx) > Math.abs(dy)) {
        swiping = true;
        e.preventDefault();
      }
    },
    { passive: false, capture: true }
  );

  el.lbStage.addEventListener(
    "touchend",
    (e) => {
      if (!el.lightbox.classList.contains("open")) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - touchX;
      const dy = t.clientY - touchY;
      if (Math.abs(dy) > SWIPE_MAX_Y) return;
      if (!swiping) return;
      if (dx > SWIPE_MIN) lightboxPrev();
      else if (dx < -SWIPE_MIN) lightboxNext();
    },
    { passive: true, capture: true }
  );

  el.themeBtn.addEventListener("click", toggleTheme);
  el.historyRefresh?.addEventListener("click", () => loadHistory());

  // init
  setTheme(localStorage.getItem("pv_theme") || "system");
  setTab("video");
  (async () => {
    const me = await getMe();
    const loggedIn = !!me;
    if (el.userChip) {
      el.userChip.style.display = loggedIn ? "" : "none";
      el.userChip.textContent = loggedIn ? `已登录：${me.username}` : "";
    }
    if (el.loginBtn) el.loginBtn.style.display = loggedIn ? "none" : "";
    if (el.registerBtn) el.registerBtn.style.display = loggedIn ? "none" : "";
    if (el.logoutBtn) el.logoutBtn.style.display = loggedIn ? "" : "none";
    if (el.historyRefresh) el.historyRefresh.style.display = loggedIn ? "" : "none";
    await loadHistory();
  })().catch(() => {});
})();

