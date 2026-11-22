// The shoutbox widget: a self-contained vanilla-DOM builder shared by all
// mount points (homepage panel, /shoutbox full page, [data-shoutbox-mount]).
// All user content is rendered through DOM APIs (textContent/createElement) —
// no innerHTML with message data, so the board is XSS-safe by construction.
//
// Data flows through one shared store: the first mount pulls the recent list,
// MessageBus "/shoutbox" pushes live creates/deletes/likes/edits/pins to every
// mounted widget, and a 60s catch-up poll guards against a dropped message.
import { ajax } from "discourse/lib/ajax";
import { iconHTML } from "discourse/lib/icon-library";
import { i18n } from "discourse-i18n";
import { relativeAge } from "discourse/lib/formatter";
import DiscourseURL from "discourse/lib/url";

const container = () => window.Discourse?.__container__;

// The jtech theme's Quick-look expand icon (same markup as jt-card__peek).
const JT_EXPAND_SVG =
  '<svg class="fa d-icon d-icon-expand svg-icon fa-width-auto svg-string" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><use href="#jt-expand"></use></svg>';

// ── shared store ─────────────────────────────────────────────────────────────

const widgets = new Set();
const messages = new Map(); // id → serialized message (ascending iteration)
let viewer = null;
let loaded = false;
let loading = false;
let lastSeenId = 0;
let pollTimer = null;
let permalinkHandled = false;
const viewedInSession = new Set();
let tagFilter = null;
let busStarted = false;
let editing = null; // { id } while a message is being edited
let emojiMap = null;
let emojiPromise = null;
let tagListPromise = null;
let searchQuery = ""; // sidebar search box filters the feed client-side
let whatsNewExpanded = false; // sidebar "What's new" card toggle
// discourse-follow state for the sidebar's suggested members (username -> bool)
const followState = new Map();
const followBusy = new Set();
let followStateLoaded = false;

const maxId = () => {
  let max = lastSeenId;
  for (const id of messages.keys()) {
    if (id > max) {
      max = id;
    }
  }
  return max;
};

const catchUp = () => {
  if (!loaded || widgets.size === 0) {
    return;
  }
  loadMessages(maxId());
};

function loadMessages(afterId = 0) {
  let qs = afterId > 0 ? `?after_id=${afterId}` : "";
  if (tagFilter) {
    qs += (qs ? "&" : "?") + `tag=${encodeURIComponent(tagFilter)}`;
  }
  return ajax(`/shoutbox/messages.json${qs}`)
    .then((payload) => {
      viewer = payload.viewer || viewer;
      (payload.messages || []).forEach((m) => {
        if (!messages.has(m.id)) {
          messages.set(m.id, m);
        }
      });
      loaded = true;
      widgets.forEach((w) => w.refresh({ animateFromId: afterId > 0 ? afterId : null }));
      if (afterId === 0 && !permalinkHandled) {
        permalinkHandled = true;
        const h = window.location.hash.match(/^#m-(\d+)$/);
        if (h) {
          setTimeout(() => {
            widgets.forEach((w) => {
              const row = w.els.list.querySelector(`[data-id="${h[1]}"]`);
              if (row) {
                row.scrollIntoView({ block: "center" });
                row.classList.add("shoutbox__item--new");
              }
            });
          }, 300);
        }
      }
    })
    .catch((e) => {
      // allow a later mount/poll to retry
      loading = false;
      if (e?.jqXHR?.status !== 403) {
        widgets.forEach((w) => w.showError());
      }
    });
}

// POST-response path of the Discourse pattern: the creator's own client
// applies the new reply IMMEDIATELY from the response (zero delay); the
// MessageBus echo later finds the id already known and no-ops — no double
// counts, no double rows.
function applyNewReply(m) {
  if (!m || messages.has(m.id)) {
    return;
  }
  if (m.reply_to_id && messages.has(m.reply_to_id)) {
    const pm = messages.get(m.reply_to_id);
    if (pm) {
      pm.reply_count = (pm.reply_count || 0) + 1;
      widgets.forEach((w) => {
        const btn = w.els?.list?.querySelector?.(
          `[data-id="${m.reply_to_id}"] .shoutbox__comment-btn`,
        );
        const label = btn?.querySelector(".number");
        if (label) {
          label.textContent = String(pm.reply_count);
        }
      });
    }
  }
  messages.set(m.id, m);
  lastSeenId = Math.max(lastSeenId, m.id);
  widgets.forEach((w) => w.insertReplyRow?.(m));
}

const startShared = () => {
  if (!busStarted) {
    busStarted = true;

    const messageBus = container()?.lookup("service:message-bus");
    if (messageBus) {
      messageBus.subscribe("/shoutbox", (data) => {
        if (data?.type === "created" && data.message) {
          const m = data.message;
          // dedupe FIRST: the creator's own client already applied this
          // message from the POST response (applyNewReply) — a second count
          // bump or row here would double everything
          if (!messages.has(m.id)) {
            if (m.reply_to_id && messages.has(m.reply_to_id)) {
              const pm = messages.get(m.reply_to_id);
              if (pm) {
                pm.reply_count = (pm.reply_count || 0) + 1;
                widgets.forEach((w) => {
                  const btn = w.els.list?.querySelector?.(
                    `[data-id="${m.reply_to_id}"] .shoutbox__comment-btn`,
                  );
                  if (btn) {
                    let label = btn.querySelector(".number");
                    if (!label) {
                      label = el("span", "number");
                      btn.appendChild(label);
                    }
                    label.textContent = String(pm.reply_count);
                  }
                });
              }
            }
            messages.set(m.id, m);
            lastSeenId = Math.max(lastSeenId, m.id);
            widgets.forEach((w) => {
              w.insertReplyRow?.(m);
              if (!m.reply_to_id) {
                w.appendRow(m, { isNew: true });
              }
            });
          }
        } else if (data?.type === "updated" && data.message) {
          const m = data.message;
          if (!messages.has(m.id)) {
            return;
          }
          messages.set(m.id, m);
          widgets.forEach((w) => w.updateRow(m));
        } else if (data?.type === "liked") {
          const m = messages.get(data.id);
          if (m) {
            m.like_count = data.like_count;
            m.liked = data.liked;
          }
          widgets.forEach((w) => {
            const btn = w.els.list?.querySelector?.(
              `[data-id="${data.id}"] .shoutbox__like`,
            );
            if (btn) {
              renderLikeBtn(btn, m || { like_count: data.like_count, liked: data.liked });
            }
            // the detail parent card's read-only like count sits outside the
            // list — widgets that care re-render it themselves
            w.onBusLike?.(data);
          });
        } else if (data?.type === "pinned") {
          const m = messages.get(data.id);
          if (m) {
            m.pinned = data.pinned;
          }
          // pinned ordering changes — refetch the list
          loading = false;
          loaded = false;
          startShared();
        } else if (data?.type === "deleted" && messages.has(data.id)) {
          const dead = messages.get(data.id);
          messages.delete(data.id);
          widgets.forEach((w) => {
            w.removeRow(data.id);
            if (dead?.reply_to_id) {
              const pm = messages.get(dead.reply_to_id);
              if (pm && pm.reply_count > 0) {
                pm.reply_count -= 1;
                const btn = w.els.list?.querySelector?.(
                  `[data-id="${dead.reply_to_id}"] .shoutbox__comment-btn`,
                );
                const label = btn?.querySelector(".number");
                if (label) {
                  if (pm.reply_count > 0) {
                    label.textContent = String(pm.reply_count);
                  } else {
                    label.remove();
                  }
                }
              }
            }
          });
        }
      });
    }

    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          catchUp();
        }
      }, 60000);
    }
  }

  if (!loading && !loaded) {
    loading = true;
    loadMessages();
  }
};

// ── rich text rendering ──────────────────────────────────────────────────────

function loadEmojis() {
  emojiPromise ||=
    ajax("/emojis.json")
      .then((groups) => {
        const map = new Map();
        Object.values(groups || {}).forEach((group) =>
          (group || []).forEach((e) => {
            if (e?.name && e.url) {
              map.set(e.name, e.url);
            }
          })
        );
        emojiMap = map;
        return map;
      })
      .catch(() => {
        emojiMap = emojiMap || new Map();
        return emojiMap;
      });
  return emojiPromise;
}

const topicTitles = new Map();
function topicTitle(id) {
  topicTitles.set(
    id,
    topicTitles.get(id) ||
      ajax(`/t/${id}.json`)
        .then((d) => String(d?.title || "").trim())
        .catch(() => "")
  );
  return topicTitles.get(id);
}

const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT = /[)\]}>,.!?;:'"，。！？；：、）》〉】\]]+$/;
const EMOJI_SPLIT = /(:[a-zA-Z0-9_+-]+:)/g;
const MENTION_SPLIT = /(@[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)/g;
const TAG_SPLIT = /(#[a-zA-Z0-9_-]+)/g;
const QUOTE_SPLIT = /(\[quote(?:="([^"]*)")?\]([\s\S]*?)\[\/quote\])/g;
const MD_SPLIT = /(\*\*[^*]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

const makeLink = (href, cls) => {
  const a = document.createElement("a");
  a.href = href;
  a.className = cls;
  a.rel = "noopener noreferrer nofollow ugc";
  return a;
};

function appendUrlNode(parent, raw) {
  const punct = raw.match(TRAILING_PUNCT)?.[0] || "";
  const url = punct ? raw.slice(0, -punct.length) : raw;

  let parsed = null;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    parent.appendChild(document.createTextNode(raw));
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    parent.appendChild(document.createTextNode(raw));
    return;
  }

  const topicMatch = parsed.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?\/?$/);
  if (topicMatch && parsed.origin === window.location.origin) {
    const id = Number(topicMatch[1]);
    const a = makeLink(parsed.href, "shoutbox__link shoutbox__link--topic");
    a.textContent = `🔗 #${id}`;
    a.title = i18n("shoutbox.topic_link");
    topicTitle(id).then((title) => {
      if (a.isConnected && title) {
        a.textContent = `🔗 ${title}`;
        a.title = title;
      }
    });
    parent.appendChild(a);
  } else {
    const a = makeLink(parsed.href, "shoutbox__link shoutbox__link--external");
    a.target = "_blank";
    a.textContent = `🔗 ${parsed.hostname.replace(/^www\./, "")}`;
    a.title = url;
    parent.appendChild(a);
  }
  if (punct) {
    parent.appendChild(document.createTextNode(punct));
  }
}

const appendTextWithMentions = (parent, text) => {
  text.split(MENTION_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const m = part.match(/^@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)$/);
    if (m) {
      const a = makeLink(`/u/${m[1].toLowerCase()}`, "shoutbox__mention");
      a.textContent = part;
      parent.appendChild(a);
    } else {
      appendTextWithTag(parent, part);
    }
  });
};

function appendTextWithTag(parent, text) {
  text.split(TAG_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const m = part.match(/^#([a-zA-Z0-9_-]+)$/);
    if (m) {
      const a = makeLink(
        `/shoutbox?tag=${encodeURIComponent(m[1].toLowerCase())}`,
        "shoutbox__tag"
      );
      a.textContent = part;
      parent.appendChild(a);
    } else {
      appendTextWithMD(parent, part);
    }
  });
}

// Inline markdown: bold / inline code / italic.
function appendTextWithMD(parent, text) {
  text.split(MD_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      parent.appendChild(el("strong", null, part.slice(2, -2)));
    } else if (/^`[^`\n]+`$/.test(part)) {
      parent.appendChild(el("code", "shoutbox__code", part.slice(1, -1)));
    } else if (/^\*[^*\n]+\*$/.test(part)) {
      parent.appendChild(el("em", null, part.slice(1, -1)));
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

const appendTextWithEmoji = (parent, text) => {
  text.split(EMOJI_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const m = part.match(/^:([a-zA-Z0-9_+-]+):$/);
    const src = m && emojiMap?.get(m[1]);
    if (src) {
      const img = document.createElement("img");
      img.className = "shoutbox__emoji";
      img.src = src;
      img.alt = part;
      img.title = part;
      img.loading = "lazy";
      parent.appendChild(img);
    } else {
      appendTextWithMentions(parent, part);
    }
  });
};

// Quote blocks first, then line-level markdown, then the inline chain.
function renderRichText(parent, text) {
  text.split(QUOTE_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const q =
      part.match(/^\[quote="([^"]*)"\]([\s\S]*)\[\/quote\]$/) ||
      part.match(/^\[quote\]([\s\S]*)\[\/quote\]$/);
    if (q) {
      const bq = el("blockquote", "shoutbox__quote");
      if (q[1]) {
        bq.appendChild(el("div", "shoutbox__quote-author", `@${q[1]}`));
      }
      const body = el("div", "shoutbox__quote-body");
      renderRichText(body, q[2].trim());
      bq.appendChild(body);
      parent.appendChild(bq);
      return;
    }
    renderLines(parent, part);
  });
}

// Resolve an image markdown URL to a safe src: Discourse upload:// short
// URLs become /uploads/short-url/… (redirects to the stored file); only
// http(s) and same-origin relative URLs are allowed — anything else (e.g.
// javascript:) returns null and the markdown renders as plain text.
function imageSrcFor(raw) {
  const url = String(raw || "");
  if (url.startsWith("upload://")) {
    return "/uploads/short-url/" + url.slice("upload://".length);
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) {
    return url;
  }
  return null;
}

// image markdown, global form — the composer counter, edit parsing and
// submit assembly all strip/extract with this same pattern
const IMAGE_MD_RE_G = /!\[[^\]\n]*\]\([^)\s]+(?:\s[^)]*)?\)/g;

const fmtBytes = (n) => {
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(n / 1024).toFixed(1)} KB`;
};

// X-style pending-image previews: a grid of large rounded tiles under the
// textarea (text above, images below), each with a floating ✕ remove button
function renderAttachments(widget) {
  const wrap = widget.els.attWrap;
  const list = widget.els.pending || [];
  if (!wrap) {
    return;
  }
  wrap.replaceChildren();
  if (list.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.dataset.count = String(list.length);

  list.forEach((item) => {
    const cell = el("div", "shoutbox__att-preview");
    cell.title = item.status === "done" ? `${item.name}${item.meta ? ` — ${item.meta}` : ""}` : "";

    if (item.status === "done" && item.short_url) {
      const img = el("img", "shoutbox__att-img");
      img.src = imageSrcFor(item.short_url);
      img.alt = item.name;
      cell.appendChild(img);
    } else {
      const ph = el("span", "shoutbox__att-ph");
      ph.textContent = item.status === "failed" ? i18n("shoutbox.upload_failed") : "···";
      if (item.status === "failed") {
        ph.classList.add("shoutbox__att-ph--error");
      }
      cell.appendChild(ph);
    }

    const remove = el("button", "shoutbox__att-remove");
    remove.type = "button";
    remove.title = i18n("shoutbox.attach_remove");
    remove.setAttribute("aria-label", i18n("shoutbox.attach_remove"));
    remove.innerHTML = iconHTML("xmark");
    remove.addEventListener("click", () => {
      widget.els.pending = widget.els.pending.filter((p) => p !== item);
      renderAttachments(widget);
      if (widget.els.sendBtn && widget.els.composer) {
        widget.els.sendBtn.disabled =
          widget.els.composer.value.replace(IMAGE_MD_RE_G, "").trim().length === 0 &&
          !widget.els.pending.some((p) => p.status === "done");
      }
    });
    cell.appendChild(remove);

    wrap.appendChild(cell);
  });
}

// Build the message's media container: all images of one message join a
// single block (X-style) — 1 image full-width, 2 side-by-side, 3+ a
// scroll-snap carousel with peeking neighbours and arrow buttons. Every
// image opens the lightbox; carousel neighbours scroll into place first.
function buildMediaBlock(items) {
  const wrap = el("div", "shoutbox__media");
  const open = (idx) =>
    openLightbox(items.map((x) => ({ src: x.src, alt: x.alt })), idx);
  const img = (x, i) => {
    const im = el("img", "shoutbox__image");
    im.src = x.src;
    im.alt = x.alt;
    im.loading = "lazy";
    im.addEventListener("click", () => open(i));
    return im;
  };
  // note: the carousel deletes .loading on its own slides (eager)

  if (items.length === 1) {
    wrap.classList.add("shoutbox__media--single");
    wrap.appendChild(img(items[0], 0));
    return wrap;
  }

  if (items.length === 2) {
    wrap.classList.add("shoutbox__media--grid");
    items.forEach((x, i) => wrap.appendChild(img(x, i)));
    return wrap;
  }

  // carousel (3+)
  wrap.classList.add("shoutbox__media--carousel");
  const track = el("div", "shoutbox__media-track");
  const stepWidth = () =>
    track.children.length > 1
      ? track.children[1].offsetLeft - track.children[0].offsetLeft
      : track.clientWidth;

  // X behavior: the prev arrow hides on the first slide, the next arrow on
  // the last — no dead ends. Re-run whenever the widths can change: image
  // loads (lazy ones start at width 0) and window resizes.
  const updateArrows = () => {
    const max = track.scrollWidth - track.clientWidth - 1;
    wrap.classList.toggle("is-start", track.scrollLeft <= 1);
    wrap.classList.toggle("is-end", track.scrollLeft >= max);
  };

  // phones (<=30em): slides go full-width with natural aspect — the track
  // height follows the current image so there are no letterbox bands
  const syncHeight = () => {
    if (!window.matchMedia("(max-width: 30em)").matches) {
      track.style.height = "";
      return;
    }
    // slides may not be laid out yet (hidden card, images unloaded) —
    // stepWidth() is then 0 and the index math would produce NaN
    const w = stepWidth();
    if (!w || !Number.isFinite(w)) {
      return;
    }
    const idx = Math.min(items.length - 1, Math.max(0, Math.round(track.scrollLeft / w)));
    const slide = track.children[idx];
    if (!slide) {
      return;
    }
    track.style.height = `${slide.offsetHeight}px`;
  };
  const refresh = () => {
    updateArrows();
    syncHeight();
  };

  let heightTimer = null;
  items.forEach((x, i) => {
    const slide = el("div", "shoutbox__media-slide");
    const im = img(x, i);
    delete im.loading; // eager: lazy slides starve the arrow-state widths
    im.addEventListener("load", refresh);
    slide.appendChild(im);
    track.appendChild(slide);
  });
  wrap.appendChild(track);

  const step = (d) => track.scrollBy({ left: d * stepWidth(), behavior: "smooth" });

  const prev = el("button", "shoutbox__media-nav shoutbox__media-nav--prev");
  prev.type = "button";
  prev.setAttribute("aria-label", "\u2039");
  prev.textContent = "\u2039";
  prev.addEventListener("click", () => step(-1));
  wrap.appendChild(prev);

  const next = el("button", "shoutbox__media-nav shoutbox__media-nav--next");
  next.type = "button";
  next.setAttribute("aria-label", "\u203a");
  next.textContent = "\u203a";
  next.addEventListener("click", () => step(1));
  wrap.appendChild(next);

  track.addEventListener(
    "scroll",
    () => {
      updateArrows();
      clearTimeout(heightTimer);
      heightTimer = setTimeout(refresh, 120); // after the snap settles
    },
    { passive: true },
  );
  window.addEventListener("resize", refresh, { passive: true });
  requestAnimationFrame(refresh);

  // clicking a peeking neighbour scrolls it into place; the centered image
  // opens the lightbox
  track.addEventListener("click", (event) => {
    const slide = event.target.closest(".shoutbox__media-slide");
    if (!slide) {
      return;
    }
    const r = slide.getBoundingClientRect();
    const vr = track.getBoundingClientRect();
    const centered = r.left >= vr.left + 8 && r.right <= vr.right - 8;
    if (!centered) {
      track.scrollTo({
        left: slide.offsetLeft - track.offsetLeft - 2,
        behavior: "smooth",
      });
    }
  });

  return wrap;
}

// Line-level markdown: headings (# ## ###), bullet lists (- ), paragraphs.
function renderLines(parent, text) {
  const lines = text.split("\n");
  // all images of the message join one media block, rendered at the first
  // image's position (X-style aggregation — no vertical photo tower)
  const mediaItems = [];
  for (const line of lines) {
    const m = line.match(/^!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)$/);
    const src = m && imageSrcFor(m[2]);
    if (m && src) {
      mediaItems.push({ src, alt: m[1] });
    }
  }
  let mediaDone = false;
  let list = null;
  const flushList = () => {
    if (list) {
      parent.appendChild(list);
      list = null;
    }
  };
  lines.forEach((line) => {
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    const li = line.match(/^[-*]\s+(.+)$/);
    const img = line.match(/^!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)$/);
    if (h) {
      flushList();
      const hd = el(
        "div",
        `shoutbox__heading shoutbox__heading--${Math.min(h[1].length + 1, 4)}`
      );
      renderInline(hd, h[2]);
      parent.appendChild(hd);
    } else if (li) {
      if (!list) {
        list = el("div", "shoutbox__list-block");
      }
      const item = el("div", "shoutbox__list-item");
      item.appendChild(document.createTextNode("\u2022 "));
      renderInline(item, li[1]);
      list.appendChild(item);
    } else if (img && imageSrcFor(img[2])) {
      flushList();
      if (!mediaDone) {
        parent.appendChild(buildMediaBlock(mediaItems));
        mediaDone = true;
      }
      // later image lines are consumed by the media container
    } else {
      flushList();
      const p = el("div", "shoutbox__line");
      if (line) {
        renderInline(p, line);
      }
      parent.appendChild(p);
    }
  });
  flushList();
}

// Inline markdown: bold / italic / inline code, then the existing chain.
function renderInline(parent, text) {
  text.split(MD_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      parent.appendChild(el("strong", null, part.slice(2, -2)));
    } else if (/^`[^`\n]+`$/.test(part)) {
      parent.appendChild(el("code", "shoutbox__code", part.slice(1, -1)));
    } else if (/^\*[^*\n]+\*$/.test(part)) {
      parent.appendChild(el("em", null, part.slice(1, -1)));
    } else {
      appendTextWithEmoji(parent, part);
    }
  });
}

// ── widget ───────────────────────────────────────────────────────────────────

// ── widget ───────────────────────────────────────────────────────────────────

export function mountShoutbox(rootEl, { variant = "panel" } = {}) {
  const widget = { rootEl, variant, els: {}, destroyed: false };

  // Page variant: the host becomes a two-column grid (memos-style) holding
  // the timeline and a sticky side column of info cards. Panel stays a single
  // card.
  let mount;
  if (variant === "page") {
    tagFilter = new URLSearchParams(window.location.search).get("tag");
    tagListPromise = null;
    rootEl.classList.add("shoutbox-page-grid");
    mount = el("div", "shoutbox shoutbox--page");
    rootEl.appendChild(mount);
    widget.els.side = el("aside", "shoutbox-side");
    rootEl.appendChild(widget.els.side);

    const tagsCard = el("div", "shoutbox-side__card shoutbox-side__card--tags");
    tagsCard.hidden = true;
    tagsCard.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_tags")));
    widget.els.tagsList = el("div", "shoutbox-side__tag-list");
    tagsCard.appendChild(widget.els.tagsList);
    widget.els.tagsCard = tagsCard;
    widget.els.side.appendChild(tagsCard);
  } else {
    rootEl.classList.add("shoutbox", "shoutbox--panel");
    mount = rootEl;
  }
  widget.mountEl = mount;

  // head
  const head = el("div", "shoutbox__head");
  if (variant === "panel") {
    head.appendChild(el("span", "shoutbox__title", `📝 ${i18n("shoutbox.title")}`));
    // Full page: the jtech theme's Quick-look expand icon (jt sprite).
    const open = el("button", "btn btn-flat no-text jt-card__peek shoutbox__open");
    open.type = "button";
    open.title = i18n("shoutbox.open");
    open.setAttribute("aria-label", i18n("shoutbox.open"));
    open.innerHTML = JT_EXPAND_SVG;
    open.addEventListener("click", () => DiscourseURL.routeTo("/shoutbox"));
    head.appendChild(open);

    // New message: hidden until the viewer payload proves posting rights.
    const plus = el("button", "btn btn-flat no-text shoutbox__compose-toggle");
    plus.type = "button";
    plus.title = i18n("shoutbox.compose");
    plus.setAttribute("aria-label", i18n("shoutbox.compose"));
    plus.innerHTML = iconHTML("plus");
    plus.hidden = true;
    plus.addEventListener("click", () => {
      const pop = widget.els.composePop;
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        widget.els.composer?.focus();
      }
    });
    widget.els.plusBtn = plus;
    head.appendChild(plus);
    mount.appendChild(head);
  }

  // list
  const list = el("ul", "shoutbox__list");
  list.appendChild(el("li", "shoutbox__msg", "…"));
  widget.els.list = list;

  // composer / login area — filled once the viewer payload arrives
  const foot = el("div", "shoutbox__foot jt-card__foot");
  widget.els.foot = foot;

  const popovers = buildPopovers(widget);

  if (variant === "page") {
    // X-style timeline: composer on top, feed below. The zero-height popovers
    // wrap sits right after the composer so the emoji/mention popovers anchor
    // just underneath it.
    mount.appendChild(foot);
    mount.appendChild(popovers);
    mount.appendChild(list);
  } else {
    mount.appendChild(list);
    mount.appendChild(foot);
    mount.appendChild(popovers);
  }

  widget.refresh = ({ animateFromId = null } = {}) => {
    // initial load (null) never animates; catch-up animates what's new
    const cutoff = animateFromId === null ? Infinity : animateFromId;
    widget.els.list.replaceChildren();
    // memos-style feed: only top-level messages render here — replies live
    // behind the comment count, in the /shoutbox/m/:id detail page
    const topLevel = [];
    for (const m of messages.values()) {
      if (!m.reply_to_id) {
        topLevel.push(m);
      }
    }
    // newest first (memos/X style); pinned float to the top
    topLevel.sort(
      (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.id - a.id,
    );
    for (const m of topLevel) {
      const animate = m.id > cutoff;
      widget.els.list.appendChild(buildRow(widget, m, { animate }));
    }
    // replies count toward lastSeenId too, or every poll would refetch them
    lastSeenId = Math.max(lastSeenId, maxId());
    showEmptyStateIfNeeded(widget);
    renderFoot(widget);
    renderSide(widget);
    applySearchFilter(widget);
    scrollToTop(widget);
  };

  widget.appendRow = (m, { isNew = false, forceScroll = false } = {}) => {
    // replies never render in the feed — the detail page owns them
    if (m.reply_to_id) {
      return;
    }
    hideEmptyState(widget);
    const animate = isNew && m.id > lastSeenId;
    lastSeenId = Math.max(lastSeenId, m.id);
    // newest-first feed: new top-level rows go to the very top
    widget.els.list.insertBefore(buildRow(widget, m, { animate }), widget.els.list.firstChild);
    renderSide(widget);
    applySearchFilter(widget);
    if (isNew || forceScroll) {
      scrollToTop(widget);
    }
  };

  widget.removeRow = (id) => {
    widget.els.list.querySelector(`[data-id="${id}"]`)?.remove();
    showEmptyStateIfNeeded(widget);
    renderSide(widget);
  };

  widget.updateRow = (m) => {
    const old = widget.els.list.querySelector(`[data-id="${m.id}"]`);
    if (!old) {
      return;
    }
    old.replaceWith(buildRow(widget, m, {}));
    applySearchFilter(widget);
  };

  widget.showError = () => {
    widget.els.list.replaceChildren(el("li", "shoutbox__msg", i18n("shoutbox.load_failed")));
  };

  widget.destroy = () => {
    widget.destroyed = true;
    widgets.delete(widget);
  };

  widgets.add(widget);
  startShared();

  if (widget.variant === "page") {
    fillTagsCard(widget);
  }

  if (loaded) {
    widget.refresh();
  } else {
    loadEmojis().then(() => {
      // the sidebar's What's-new excerpts render :emoji: from the map —
      // re-render once it arrives so shortcodes become images
      if (!widget.destroyed && widget.els.side) {
        renderSide(widget);
      }
    });
  }

  return widget;
}

export function unmountShoutbox(widget) {
  widget?.destroy();
}

// ── pieces ───────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "");
const userHref = (m) => `/u/${esc(m.user?.username).toLowerCase()}`;
const avatarSrc = (m, size = 48) =>
  esc(m.user?.avatar_template || "").replace("{size}", String(size));

const insertAtCursor = (textarea, text) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
};

// wrap the selected text with markers (bold / italic / code); empty selection
// inserts the markers and puts the cursor between them
const wrapSelection = (textarea, before, after = before) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const sel = textarea.value.slice(start, end);
  textarea.value =
    textarea.value.slice(0, start) + before + sel + after + textarea.value.slice(end);
  const selStart = start + before.length;
  const selEnd = selStart + sel.length;
  textarea.setSelectionRange(selStart, selEnd);
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

// prefix each selected line (headings "# ", bullets "- ")
const prefixLine = (textarea, prefix) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
  const lines = textarea.value.slice(lineStart, end).split("\n");
  const replaced = lines.map((l) => (l.startsWith(prefix) ? l : prefix + l)).join("\n");
  textarea.value = textarea.value.slice(0, lineStart) + replaced + textarea.value.slice(end);
  const selEnd = lineStart + replaced.length;
  textarea.setSelectionRange(lineStart, selEnd);
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

function buildRow(widget, m, { animate = false, isReply = false } = {}) {
  const li = el("li", "shoutbox__item jt-card");
  li.dataset.id = m.id;
  const replyRow = isReply || !!m.reply_to_id;
  li.classList.toggle("shoutbox__item--reply", replyRow);
  if (m.reply_to_id) {
    li.dataset.replyTo = m.reply_to_id;
  }
  if (m.pinned) {
    li.classList.add("shoutbox__item--pinned");
  }
  if (animate) {
    li.classList.add("shoutbox__item--new");
  }

  // X-style anatomy: the avatar is its own left column and the name row +
  // content align beside it; the stats strip stays full-width below.
  const main = el("div", "shoutbox__card-main");
  if (m.user?.avatar_template) {
    const av = el("img", "shoutbox__author-avatar");
    av.src = avatarSrc(m, 48);
    av.alt = "";
    av.loading = "lazy";
    main.appendChild(av);
  }
  const col = el("div", "shoutbox__card-main-col");

  // meta: dual name, pinned flag + row menu right
  const meta = el("div", "jt-card__meta");
  const author = el("span", "shoutbox__author");
  const name = makeLink(userHref(m), "shoutbox__name");
  name.textContent = esc(m.user?.name || m.user?.username);
  author.appendChild(name);
  const handle = makeLink(userHref(m), "shoutbox__handle");
  handle.textContent = `@${esc(m.user?.username)}`;
  author.appendChild(handle);
  meta.appendChild(author);
  const flags = el("span", "jt-card__flags");
  if (m.pinned) {
    flags.appendChild(el("span", "jt-pill", `📌 ${i18n("shoutbox.pinned_label")}`));
  }
  const menuBtn = el("button", "jt-card__peek btn btn-flat no-text");
  menuBtn.type = "button";
  menuBtn.innerHTML = iconHTML("ellipsis-vertical");
  menuBtn.title = i18n("shoutbox.menu");
  menuBtn.setAttribute("aria-label", i18n("shoutbox.menu"));
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openRowMenu(widget, m, meta);
  });
  flags.appendChild(menuBtn);
  meta.appendChild(flags);
  col.appendChild(meta);

  // body: content
  const body = el("div", "shoutbox__body");
  const text = el("div", "shoutbox__text");
  if (m.color) {
    text.style.color = m.color;
  }
  renderRichText(text, esc(m.message));
  // no folding: 200 chars max ≈ a handful of lines — always show the full text
  body.appendChild(text);
  // clicking ANYWHERE on the card opens the per-message detail page — the
  // card already advertises this with cursor: pointer (memos/X affordance).
  // Links, buttons, the stats strip and the lightbox media keep their own
  // behavior, and the in-place editor suppresses navigation entirely.
  li.addEventListener("click", (event) => {
    if (
      event.target.closest("a, button, .shoutbox__media, .shoutbox__foot") ||
      li.classList.contains("shoutbox__item--editing")
    ) {
      return;
    }
    DiscourseURL.routeTo(`/shoutbox/m/${m.id}`);
  });

  col.appendChild(body);

  // foot: stats (comment / like / views / time)
  const foot = el("div", "shoutbox__foot jt-card__foot");

  const commentBtn = el("button", "shoutbox__stat-btn jt-card__stat shoutbox__comment-btn");
  commentBtn.type = "button";
  commentBtn.innerHTML = iconHTML("far-comment");
  if (m.reply_count > 0) {
    commentBtn.appendChild(el("span", "number", String(m.reply_count)));
  }
  commentBtn.title = i18n("shoutbox.comment");
  commentBtn.setAttribute("aria-label", i18n("shoutbox.comment"));
  commentBtn.addEventListener("click", () => openReplyModal(widget, m));
  foot.appendChild(commentBtn);

  const likeBtn = el("button", "shoutbox__stat-btn jt-card__stat shoutbox__like");
  likeBtn.type = "button";
  likeBtn.title = i18n("shoutbox.like");
  likeBtn.setAttribute("aria-label", i18n("shoutbox.like"));
  renderLikeBtn(likeBtn, m);
  likeBtn.addEventListener("click", () => toggleLike(widget, m, likeBtn));
  foot.appendChild(likeBtn);

  const views = el("span", "shoutbox__stat-btn jt-card__stat shoutbox__views");
  views.title = i18n("shoutbox.views", { n: m.views || 0 });
  views.innerHTML =
    iconHTML("far-eye") + '<span class="number">' + (m.views || 0) + "</span>";
  foot.appendChild(views);

  const activity = el("span", "shoutbox__stat-btn jt-card__stat --activity");
  const date = new Date(m.created_at);
  if (!isNaN(date.getTime())) {
    const time = el("span", "relative-date");
    // data-time (epoch ms) is what Discourse's 60s updateRelativeAge pass
    // re-reads — without it the refresher renders "Invalid date"
    time.dataset.time = date.getTime();
    time.textContent = relativeAge(date, { format: "tiny" });
    time.title = date.toLocaleString();
    activity.appendChild(time);
    foot.appendChild(activity);
  }

  main.appendChild(col);
  li.appendChild(main);

  // X-style media breakout: images render full card width, flush under the
  // avatar axis — hoisted out of the content column
  const media = li.querySelector(":scope .shoutbox__media");
  if (media) {
    // append (not insertBefore foot — foot is not a child yet, that throws);
    // foot is appended right after, so the order stays main > media > foot
    li.appendChild(media);
  }

  li.appendChild(foot);

  // in-place editor: the row being edited renders as an editor everywhere
  if (editing && editing.id === m.id) {
    applyRowEditor(widget, li, m);
  }

  return li;
}

function renderLikeBtn(btn, m) {
  btn.innerHTML =
    iconHTML("far-heart") +
    (m.like_count > 0 ? '<span class="number">' + m.like_count + "</span>" : "");
  btn.classList.toggle("is-liked", !!m.liked);
}

function toggleLike(widget, m, btn) {
  if (!viewer?.signed_in) {
    window.location.href = "/login";
    return;
  }
  btn.disabled = true;
  ajax(`/shoutbox/messages/${m.id}/like`, { type: "POST" })
    .then((payload) => {
      const msg = messages.get(m.id);
      if (msg) {
        msg.like_count = payload.like_count;
        msg.liked = payload.liked;
      }
      renderLikeBtn(btn, msg || Object.assign({}, m, payload));
    })
    .catch((err) => {
      window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
    })
    .finally(() => {
      btn.disabled = false;
    });
}

function deleteMessage(widget, m) {
  if (!window.confirm(i18n("shoutbox.confirm_delete"))) {
    return;
  }
  ajax(`/shoutbox/messages/${m.id}.json`, { type: "DELETE" }).catch((err) => {
    window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
  });
}

function copyMessageLink(m) {
  const url = `${window.location.origin}/shoutbox#m-${m.id}`;
  navigator.clipboard
    ? navigator.clipboard.writeText(url).catch(() => {})
    : window.prompt(i18n("shoutbox.copy_link"), url);
  window.alert(i18n("shoutbox.copied"));
}

// X-style in-place editing: the row itself turns into an editor (textarea +
// removable image previews + Cancel/Save). editing = { id, text, pending } —
// state lives on the module so a background refresh can rebuild the editor
// without losing typed content.
function startEdit(widget, m) {
  if (editing) {
    return;
  }
  const images = [...m.message.matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g)];
  editing = {
    id: m.id,
    text: m.message.replace(IMAGE_MD_RE_G, "").replace(/\n{3,}/g, "\n\n").trim(),
    pending: images.map((g, i) => ({
      id: `edit-${g[1] || i}`,
      name: g[1] || "image",
      status: "done",
      short_url: g[2],
    })),
  };
  // re-render the row (in every mounted widget) as the editor
  widgets.forEach((w) => w.updateRow(m));
}

// Replace a row's body with the editor; called from buildRow when the row
// belongs to the message being edited. Layout follows memos: borderless
// textarea, image tiles, then a bottom bar with [+] (add images) on the left
// and Cancel/Save on the right.
function applyRowEditor(widget, li, m) {
  li.classList.add("shoutbox__item--editing");
  // the hoisted media block (card-level since the breakout) would duplicate
  // the editor's pending previews — remove it; buildRow restores on save
  li.querySelector(":scope > .shoutbox__media")?.remove();
  const body = li.querySelector(".shoutbox__body");
  const foot = li.querySelector(".shoutbox__foot");
  if (!body) {
    return;
  }
  foot?.style.setProperty("display", "none");
  // wipe the rendered text first — the body must hold ONLY the editor, or
  // the original content stays visible above the textarea (duplicated)
  body.replaceChildren();
  body.classList.add("shoutbox__body--editing");

  const ta = el("textarea", "shoutbox__edit-input");
  ta.value = editing.text;
  ta.maxLength = viewer?.max_length || 200;
  ta.rows = 3;
  ta.addEventListener("input", () => {
    editing.text = ta.value;
  });
  makeAutoGrow(ta);
  ta.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRowEdit(m);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveRowEdit(widget, ta, saveBtn);
    }
  });
  body.appendChild(ta);

  // image tiles — rebuilt from editing.pending so uploads can land mid-edit
  const grid = el("div", "shoutbox__attachments");
  const renderGrid = () => {
    grid.replaceChildren();
    grid.dataset.count = String(editing.pending.length);
    grid.hidden = editing.pending.length === 0;
    editing.pending.forEach((item) => {
      const cell = el("div", "shoutbox__att-preview");
      cell.title = item.status === "done" ? item.name : "";
      if (item.status === "done" && item.short_url) {
        const img = el("img", "shoutbox__att-img");
        img.src = imageSrcFor(item.short_url);
        img.alt = item.name;
        cell.appendChild(img);
      } else {
        const ph = el("span", "shoutbox__att-ph");
        ph.textContent = item.status === "failed" ? i18n("shoutbox.upload_failed") : "···";
        if (item.status === "failed") {
          ph.classList.add("shoutbox__att-ph--error");
        }
        cell.appendChild(ph);
      }
      const remove = el("button", "shoutbox__att-remove");
      remove.type = "button";
      remove.title = i18n("shoutbox.attach_remove");
      remove.setAttribute("aria-label", i18n("shoutbox.attach_remove"));
      remove.innerHTML = iconHTML("xmark");
      remove.addEventListener("click", () => {
        editing.pending = editing.pending.filter((p) => p !== item);
        renderGrid();
      });
      cell.appendChild(remove);
      grid.appendChild(cell);
    });
  };
  renderGrid();
  body.appendChild(grid);

  // full composer toolbar — Cancel + Save on the right
  const bar = el("div", "shoutbox__edit-bar");
  const icons = buildComposerToolbar(ta, body, {
    pending: editing.pending,
    onUpload: () => renderGrid(),
  });
  bar.appendChild(icons);

  const actions = el("div", "shoutbox__edit-actions");
  const cancelBtn = el("button", "shoutbox__edit-cancel");
  cancelBtn.type = "button";
  cancelBtn.textContent = i18n("shoutbox.cancel");
  cancelBtn.addEventListener("click", () => cancelRowEdit(m));
  actions.appendChild(cancelBtn);

  const saveBtn = el("button", "shoutbox__send shoutbox__edit-save");
  saveBtn.type = "button";
  saveBtn.textContent = i18n("shoutbox.save");
  saveBtn.addEventListener("click", () => saveRowEdit(widget, ta, saveBtn));
  actions.appendChild(saveBtn);
  bar.appendChild(actions);

  body.appendChild(bar);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function cancelRowEdit(m) {
  editing = null;
  const current = messages.get(m.id) || m;
  widgets.forEach((w) => w.updateRow(current));
}

function saveRowEdit(widget, ta, saveBtn) {
  const attachMd = (editing.pending || [])
    .filter((p) => p.status === "done" && p.short_url)
    .map((p) => `\n![${p.name.replace(/\.[^.]+$/, "").slice(0, 60) || "image"}](${p.short_url})`)
    .join("");
  const text = (ta.value.trim() + attachMd).trim();
  if (!text) {
    return;
  }
  saveBtn.disabled = true;
  saveBtn.textContent = i18n("shoutbox.posting");
  ajax(`/shoutbox/messages/${editing.id}.json`, { type: "PUT", data: { message: text } })
    .then((payload) => {
      if (payload?.message) {
        messages.set(payload.message.id, payload.message);
        editing = null;
        widgets.forEach((w) => w.updateRow(payload.message));
      }
    })
    .catch((err) => {
      const msg =
        err?.jqXHR?.responseJSON?.errors?.[0] ||
        (err?.jqXHR?.status === 429 ? i18n("shoutbox.rate_limited") : i18n("shoutbox.send_failed"));
      window.alert(msg);
      saveBtn.disabled = false;
      saveBtn.textContent = i18n("shoutbox.save");
    });
}

function openRowMenu(widget, m, container) {
  container.querySelector(":scope > .shoutbox__menu")?.remove();
  const menu = el("div", "shoutbox__menu");
  const add = (label, cls, fn) => {
    const b = el("button", "shoutbox__menu-item" + (cls ? " " + cls : ""));
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.remove();
      document.removeEventListener("click", close);
      fn();
    });
    menu.appendChild(b);
  };

  if (m.can_edit) {
    add(i18n("shoutbox.edit"), "", () => startEdit(widget, m));
  }
  if (m.can_delete) {
    add(i18n("shoutbox.delete"), "is-danger", () => deleteMessage(widget, m));
  }
  if (viewer?.staff) {
    add(i18n(m.pinned ? "shoutbox.unpin" : "shoutbox.pin"), "", () => {
      ajax(`/shoutbox/messages/${m.id}/pin`, { type: "POST" }).catch((err) => {
        window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
      });
    });
  }
  add(i18n("shoutbox.copy_link"), "", () => copyMessageLink(m));

  container.appendChild(menu);
  const close = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

// memos-style inline comment box under a message row: submit posts the
// message as a reply (reply_to_id), rendered indented under its parent.
// X-style reply modal, opened from the comment stat: the parent message on
// top, viewer avatar + input + (image / emoji) icons + Reply pill below.
// Submitting closes the modal — the MessageBus "created" event bumps the
// parent's count on every mounted feed.
function openReplyModal(widget, m, opts = {}) {
  if (!viewer?.signed_in) {
    DiscourseURL.routeTo("/login");
    return;
  }
  const parent = messages.get(m.id) || m;

  const overlay = el("div", "shoutbox__reply-overlay");
  const dialog = el("div", "shoutbox__reply");

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", escHandler);
  };
  const escHandler = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  // mobile full-screen header: Cancel left, Post right (desktop hides it —
  // its Cancel/Reply live in the bottom bar)
  const topbar = el("div", "shoutbox__reply-topbar");
  const topCancel = el("button", "shoutbox__reply-top-cancel");
  topCancel.type = "button";
  topCancel.textContent = i18n("shoutbox.cancel");
  topCancel.addEventListener("click", close);
  const topPost = el("button", "shoutbox__reply-top-post");
  topPost.type = "button";
  topPost.textContent = i18n("shoutbox.reply_send");
  topPost.disabled = true;
  topbar.appendChild(topCancel);
  topbar.appendChild(topPost);
  dialog.appendChild(topbar);

  // X reply-thread: the parent author's avatar and mine share one vertical
  // rail, joined by a thin lineage line; the right column stacks the parent
  // message over the reply composer.
  const thread = el("div", "shoutbox__reply-thread");
  const rail = el("div", "shoutbox__reply-rail");
  if (parent.user?.avatar_template) {
    const img = el("img", "shoutbox__reply-avatar");
    img.src = parent.user.avatar_template.replace("{size}", "96");
    img.alt = "";
    rail.appendChild(img);
  }
  rail.appendChild(el("span", "shoutbox__reply-line"));
  thread.appendChild(rail);

  const main = el("div", "shoutbox__reply-main");
  const card = el("div", "shoutbox__reply-card");
  const who = el("div", "shoutbox__reply-who");
  const name = makeLink(userHref(parent), "shoutbox__reply-name");
  name.textContent = parent.user?.name || parent.user?.username || "?";
  who.appendChild(name);
  who.appendChild(el("span", "shoutbox__reply-handle", `@${parent.user?.username || "?"}`));
  const date = new Date(parent.created_at);
  if (!isNaN(date.getTime())) {
    const time = el("span", "shoutbox__reply-time");
    time.textContent = relativeAge(date, { format: "tiny" });
    time.title = date.toLocaleString();
    who.appendChild(time);
  }
  card.appendChild(who);

  const content = el("div", "shoutbox__reply-content");
  renderRichText(content, parent.message || "");
  card.appendChild(content);

  card.appendChild(
    el(
      "div",
      "shoutbox__replying-to",
      i18n("shoutbox.replying_to", { username: parent.user?.username || "?" }),
    ),
  );
  main.appendChild(card);

  // reply composer: my avatar sits directly in front of the input (X), the
  // lineage line above runs down the same axis to meet it
  const compose = el("div", "shoutbox__reply-compose");
  if (viewer.avatar_template) {
    const my = el("img", "shoutbox__reply-my-avatar");
    my.src = viewer.avatar_template.replace("{size}", "48");
    my.alt = "";
    compose.appendChild(my);
  }
  const col = el("div", "shoutbox__reply-col");

  const ta = el("textarea", "shoutbox__reply-input");
  ta.rows = 1;
  ta.maxLength = viewer?.max_length || 200;
  ta.placeholder = i18n("shoutbox.reply_placeholder");
  col.appendChild(ta);

  // pending image previews — same X-style grid as the main composer
  const pending = [];
  const attWrap = el("div", "shoutbox__attachments");
  attWrap.hidden = true;
  col.appendChild(attWrap);

  const renderPreviews = () => {
    attWrap.replaceChildren();
    attWrap.hidden = pending.length === 0;
    attWrap.dataset.count = String(pending.length);
    pending.forEach((item) => {
      const cell = el("div", "shoutbox__att-preview");
      cell.title = item.status === "done" ? item.name : "";
      if (item.status === "done" && item.short_url) {
        const img = el("img", "shoutbox__att-img");
        img.src = imageSrcFor(item.short_url);
        img.alt = item.name;
        cell.appendChild(img);
      } else {
        const ph = el("span", "shoutbox__att-ph");
        ph.textContent =
          item.status === "failed" ? i18n("shoutbox.upload_failed") : "\u00b7\u00b7\u00b7";
        if (item.status === "failed") {
          ph.classList.add("shoutbox__att-ph--error");
        }
        cell.appendChild(ph);
      }
      const remove = el("button", "shoutbox__att-remove");
      remove.type = "button";
      remove.title = i18n("shoutbox.attach_remove");
      remove.setAttribute("aria-label", i18n("shoutbox.attach_remove"));
      remove.innerHTML = iconHTML("xmark");
      remove.addEventListener("click", () => {
        pending.splice(pending.indexOf(item), 1);
        renderPreviews();
        update();
      });
      cell.appendChild(remove);
      attWrap.appendChild(cell);
    });
  };

  const bar = el("div", "shoutbox__reply-bar");
  const icons = buildComposerToolbar(ta, col, {
    pending,
    onUpload: () => {
      renderPreviews();
      update();
    },
  });
  bar.appendChild(icons);

  const actions = el("div", "shoutbox__reply-actions");

  const cancel = el("button", "shoutbox__edit-cancel");
  cancel.type = "button";
  cancel.textContent = i18n("shoutbox.cancel");
  actions.appendChild(cancel);

  const publish = el("button", "shoutbox__send");
  publish.type = "button";
  publish.textContent = i18n("shoutbox.reply_send");
  publish.disabled = true;
  actions.appendChild(publish);
  bar.appendChild(actions);

  col.appendChild(bar);
  compose.appendChild(col);
  main.appendChild(compose);
  thread.appendChild(main);
  dialog.appendChild(thread);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  makeAutoGrow(ta);
  const update = () => {
    publish.disabled =
      ta.value.trim().length === 0 && !pending.some((p) => p.status === "done");
    topPost.disabled = publish.disabled;
  };
  update();
  ta.addEventListener("input", update);

  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  document.addEventListener("keydown", escHandler);

  const submit = () => {
    const attachMd = pending
      .filter((p) => p.status === "done" && p.short_url)
      .map(
        (p) =>
          `\n![${p.name.replace(/\.[^.]+$/, "").slice(0, 60) || "image"}](${p.short_url})`,
      )
      .join("");
    const text = (ta.value.trim() + attachMd).trim();
    if (!text || publish.disabled) {
      return;
    }
    publish.disabled = true;
    publish.textContent = i18n("shoutbox.posting");
    ajax("/shoutbox/messages.json", {
      type: "POST",
      data: { message: text, reply_to_id: m.id },
    })
      .then((payload) => {
        close();
        // Discourse pattern: the creator's own client applies the new reply
        // from the POST response immediately; the MessageBus echo finds the
        // id already known and no-ops
        applyNewReply(payload?.message);
        opts.onPosted?.();
      })
      .catch((err) => {
        publish.disabled = false;
        publish.textContent = i18n("shoutbox.reply_send");
        window.alert(
          err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"),
        );
      });
  };

  topPost.addEventListener("click", submit);
  publish.addEventListener("click", submit);
  ta.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault();
      submit();
    }
  });

  ta.focus();
}

// ── lightbox ──────────────────────────────────────────────────────────────────
// Full-page overlay for message images: current image centered, ‹ › album
// navigation, Esc / overlay click closes. Self-contained on purpose — core's
// lightbox binds to post content we don't render through.
let lightbox = null;

function closeLightbox() {
  if (!lightbox) {
    return;
  }
  lightbox.overlay.remove();
  document.removeEventListener("keydown", lightbox.keyHandler);
  lightbox = null;
}

function showLightboxImage() {
  const { list, idx, img, counter, prev, next } = lightbox;
  const item = list[idx];
  img.src = item.src;
  img.alt = item.alt || "";
  counter.textContent = list.length > 1 ? `${idx + 1} / ${list.length}` : "";
  prev.hidden = list.length < 2;
  next.hidden = list.length < 2;
}

function openLightbox(list, idx = 0) {
  closeLightbox();
  const overlay = el("div", "shoutbox__lightbox");
  const img = el("img", "shoutbox__lightbox-img");
  const counter = el("span", "shoutbox__lightbox-count");
  const prev = el("button", "shoutbox__lightbox-nav shoutbox__lightbox-nav--prev");
  prev.type = "button";
  prev.textContent = "\u2039";
  const next = el("button", "shoutbox__lightbox-nav shoutbox__lightbox-nav--next");
  next.type = "button";
  next.textContent = "\u203a";
  const close = el("button", "shoutbox__lightbox-close");
  close.type = "button";
  close.title = i18n("shoutbox.cancel");
  close.setAttribute("aria-label", i18n("shoutbox.cancel"));
  close.innerHTML = iconHTML("xmark");

  const state = { list, idx, overlay, img, counter, prev, next };
  const step = (d) => {
    state.idx = (state.idx + d + list.length) % list.length;
    showLightboxImage();
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  close.addEventListener("click", closeLightbox);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeLightbox();
    }
  });
  const keyHandler = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLightbox();
    } else if (event.key === "ArrowLeft" && list.length > 1) {
      step(-1);
    } else if (event.key === "ArrowRight" && list.length > 1) {
      step(1);
    }
  };

  overlay.appendChild(img);
  overlay.appendChild(counter);
  overlay.appendChild(prev);
  overlay.appendChild(next);
  overlay.appendChild(close);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", keyHandler);
  lightbox = state;
  showLightboxImage();
}

function scrollToTop(widget) {
  const list = widget.els.list;
  requestAnimationFrame(() => {
    list.scrollTop = 0;
  });
}

// ── side column (page variant, memos-style cards) ────────────────────────────
// Follow / Following toggle for the suggested-members card (discourse-follow
// plugin: PUT/DELETE /follow/:username). Optimistic flip, rollback on error.
function buildFollowButton(user) {
  const btn = el("button", "shoutbox-side__follow");
  btn.type = "button";
  const render = () => {
    const following = followState.get(user.username) === true;
    btn.textContent = i18n(following ? "shoutbox.following" : "shoutbox.follow");
    btn.classList.toggle("is-following", following);
    btn.disabled = followBusy.has(user.username);
  };
  render();
  btn.addEventListener("click", () => {
    if (!viewer?.signed_in) {
      DiscourseURL.routeTo("/login");
      return;
    }
    if (followBusy.has(user.username)) {
      return;
    }
    const next = followState.get(user.username) !== true;
    followBusy.add(user.username);
    btn.disabled = true;
    ajax(`/follow/${encodeURIComponent(user.username)}.json`, {
      type: next ? "PUT" : "DELETE",
    })
      .then(() => {
        followState.set(user.username, next);
      })
      .catch((err) => {
        window.alert(
          err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.follow_failed"),
        );
      })
      .finally(() => {
        followBusy.delete(user.username);
        widgets.forEach(renderSide);
      });
  });
  return btn;
}

// Renders the X-style pending-image grid (shared by the composer, the reply
// modal, the in-place editor and the detail-page composer). `onChange` fires
// whenever the list changes so the host can update its send-button state.
function renderPendingAttachments(wrap, list, onChange) {
  wrap.replaceChildren();
  wrap.hidden = list.length === 0;
  wrap.dataset.count = String(list.length);
  list.forEach((item) => {
    const cell = el("div", "shoutbox__att-preview");
    cell.title = item.status === "done" ? item.name : "";
    if (item.status === "done" && item.short_url) {
      const img = el("img", "shoutbox__att-img");
      img.src = imageSrcFor(item.short_url);
      img.alt = item.name;
      cell.appendChild(img);
    } else {
      const ph = el("span", "shoutbox__att-ph");
      ph.textContent =
        item.status === "failed" ? i18n("shoutbox.upload_failed") : "\u00b7\u00b7\u00b7";
      if (item.status === "failed") {
        ph.classList.add("shoutbox__att-ph--error");
      }
      cell.appendChild(ph);
    }
    const remove = el("button", "shoutbox__att-remove");
    remove.type = "button";
    remove.title = i18n("shoutbox.attach_remove");
    remove.setAttribute("aria-label", i18n("shoutbox.attach_remove"));
    remove.innerHTML = iconHTML("xmark");
    remove.addEventListener("click", () => {
      list.splice(list.indexOf(item), 1);
      renderPendingAttachments(wrap, list, onChange);
      onChange?.();
    });
    cell.appendChild(remove);
    // done previews open the lightbox (album = all finished uploads here)
    if (item.status === "done" && item.short_url) {
      cell.classList.add("is-viewable");
      cell.addEventListener("click", (event) => {
        if (event.target.closest(".shoutbox__att-remove")) {
          return;
        }
        const done = list.filter((p) => p.status === "done" && p.short_url);
        openLightbox(
          done.map((p) => ({ src: imageSrcFor(p.short_url), alt: p.name })),
          Math.max(0, done.indexOf(item)),
        );
      });
    }
    wrap.appendChild(cell);
  });
}

// X-style auto-grow: the textarea follows its content line by line. The
// CSS max-height is the cap — past it the (thin) scrollbar takes over and
// overflow-y flips from hidden to auto.
function makeAutoGrow(ta) {
  const grow = () => {
    ta.style.height = "auto";
    const max = parseFloat(getComputedStyle(ta).maxHeight) || 0;
    // +1px: fractional line heights can leave a 1px overflow, which would
    // summon the scrollbar while growing
    ta.style.height = `${Math.min(ta.scrollHeight + 1, max || ta.scrollHeight + 1)}px`;
    ta.style.overflowY = max && ta.scrollHeight > max ? "auto" : "hidden";
  };
  ta.addEventListener("input", grow);
  // measure only after the textarea has landed in the document — a detached
  // node reports scrollHeight 0 and the box would collapse to min-height
  requestAnimationFrame(grow);
  return grow;
}

// The full composer toolbar — bold / italic / heading / list / tag / image /
// emoji — shared by every compose surface. Uploads land in `pending` (the
// caller renders previews via renderPendingAttachments); `onUpload` fires
// whenever that list changes. Popovers anchor to `host` (position:relative).
function buildComposerToolbar(ta, host, { pending, onUpload }) {
  const icons = el("div", "shoutbox__reply-icons");

  // image upload — Discourse's own Upload pipeline, 4 per message
  const fileInput = el("input", "shoutbox__file-input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  icons.appendChild(fileInput);

  const imageBtn = el("button", "shoutbox__composer-btn");
  imageBtn.type = "button";
  imageBtn.title = i18n("shoutbox.image");
  imageBtn.setAttribute("aria-label", i18n("shoutbox.image"));
  imageBtn.innerHTML = iconHTML("far-image");
  imageBtn.addEventListener("click", () => fileInput.click());
  icons.appendChild(imageBtn);

  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = "";
    if (files.length === 0 || imageBtn.disabled) {
      return;
    }
    imageBtn.disabled = true;
    imageBtn.classList.add("is-busy");
    const room = 4 - pending.filter((p) => p.status !== "failed").length;
    const batch = files.slice(0, Math.max(0, room));
    if (batch.length === 0) {
      imageBtn.disabled = false;
      imageBtn.classList.remove("is-busy");
      return;
    }
    let settled = 0;
    batch.forEach((file) => {
      const item = {
        name: file.name,
        meta: `${(file.type.split("/")[1] || "image").toUpperCase()} \u00b7 ${fmtBytes(file.size)}`,
        status: "uploading",
      };
      pending.push(item);
      onUpload?.();
      const fd = new FormData();
      fd.append("file", file, file.name);
      ajax("/shoutbox/uploads.json", {
        type: "POST",
        data: fd,
        processData: false,
        contentType: false,
      })
        .then((data) => {
          item.short_url = data.short_url || data.url;
          item.status = "done";
        })
        .catch(() => {
          item.status = "failed";
        })
        .finally(() => {
          settled++;
          if (settled === batch.length) {
            imageBtn.disabled = false;
            imageBtn.classList.remove("is-busy");
          }
          onUpload?.();
        });
    });
  });

  // emoji popover — shared map, inserted at the cursor
  const emojiBtn = el("button", "shoutbox__composer-btn");
  emojiBtn.type = "button";
  emojiBtn.title = i18n("shoutbox.emoji_picker");
  emojiBtn.setAttribute("aria-label", i18n("shoutbox.emoji_picker"));
  emojiBtn.innerHTML = iconHTML("face-smile");
  icons.appendChild(emojiBtn);

  const emojiPop = el("div", "shoutbox__reply-emoji");
  emojiPop.hidden = true;
  host.appendChild(emojiPop);

  emojiBtn.addEventListener("click", () => {
    emojiPop.hidden = !emojiPop.hidden;
    if (emojiPop.hidden) {
      return;
    }
    if (emojiPop.children.length === 0) {
      loadEmojis().then((map) => {
        if (map.size === 0) {
          emojiBtn.hidden = true;
          emojiPop.hidden = true;
          return;
        }
        map.forEach((url, name) => {
          const img = el("img", "shoutbox__emoji-option");
          img.src = url;
          img.alt = `:${name}:`;
          img.title = `:${name}:`;
          img.loading = "lazy";
          img.addEventListener("click", () => {
            insertAtCursor(ta, `:${name}:`);
            emojiPop.hidden = true;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          });
          emojiPop.appendChild(img);
        });
      });
    }
  });

  // markdown formats — inline again; the icon strip scrolls on narrow
  // screens (the actions stay pinned)
  const fmtBtn = (icon, key, fn) => {
    const b = el("button", "shoutbox__composer-btn");
    b.type = "button";
    b.title = i18n(key);
    b.setAttribute("aria-label", i18n(key));
    b.innerHTML = iconHTML(icon);
    b.addEventListener("click", () => fn(ta));
    return b;
  };
  icons.appendChild(fmtBtn("bold", "shoutbox.bold", (x) => wrapSelection(x, "**")));
  icons.appendChild(fmtBtn("italic", "shoutbox.italic", (x) => wrapSelection(x, "*")));
  icons.appendChild(fmtBtn("heading", "shoutbox.heading", (x) => prefixLine(x, "## ")));
  icons.appendChild(fmtBtn("list-ul", "shoutbox.list", (x) => prefixLine(x, "- ")));
  icons.appendChild(buildTagButton(ta, host));

  return icons;
}

// # tag button: inserts "#" at the cursor and suggests existing tags (tags
// are #word tokens in the message text itself; list comes from the cached
// /shoutbox/tags.json the sidebar also uses)
function buildTagButton(ta, host) {
  const btn = el("button", "shoutbox__composer-btn shoutbox__tag-btn");
  btn.type = "button";
  btn.title = i18n("shoutbox.tag");
  btn.setAttribute("aria-label", i18n("shoutbox.tag"));
  btn.textContent = "#";

  const pop = el("div", "shoutbox__tag-pop");
  pop.hidden = true;
  host.appendChild(pop);

  const hide = () => {
    pop.hidden = true;
  };
  const show = (query) => {
    loadTagList().then((tags) => {
      const q = query.toLowerCase();
      const matches = tags
        .filter((tg) => !q || tg.name.toLowerCase().startsWith(q))
        .slice(0, 8);
      pop.replaceChildren();
      if (matches.length === 0) {
        hide();
        return;
      }
      matches.forEach(({ name, count }) => {
        const row = el("button", "shoutbox__tag-option");
        row.type = "button";
        row.textContent = `#${name}`;
        row.appendChild(el("span", "shoutbox__tag-count", String(count)));
        row.addEventListener("click", () => {
          const pos = ta.selectionStart ?? ta.value.length;
          const before = ta.value.slice(0, pos).replace(
            /#[a-zA-Z0-9_-]*$/,
            `#${name} `,
          );
          ta.value = before + ta.value.slice(pos);
          ta.setSelectionRange(before.length, before.length);
          ta.focus();
          hide();
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        });
        pop.appendChild(row);
      });
      pop.hidden = false;
    });
  };
  const refresh = () => {
    const pos = ta.selectionStart ?? ta.value.length;
    const m = ta.value.slice(0, pos).match(/#([a-zA-Z0-9_-]*)$/);
    if (m) {
      show(m[1]);
    } else {
      hide();
    }
  };

  btn.addEventListener("click", () => {
    if (!pop.hidden) {
      hide();
      return;
    }
    insertAtCursor(ta, "#");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    refresh();
  });
  ta.addEventListener("input", refresh);
  ta.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
    }
  });
  ta.addEventListener("blur", () => setTimeout(hide, 150));
  return btn;
}

function renderSide(widget) {
  const side = widget.els.side;
  if (!side) {
    return;
  }

  const counts = new Map();
  for (const m of messages.values()) {
    const name = m.user?.username;
    if (!name) {
      continue;
    }
    const entry = counts.get(name) || { user: m.user, count: 0 };
    entry.count += 1;
    counts.set(name, entry);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 5);

  // search box — built once per widget; it must survive renderSide rebuilds
  // or typing would wipe focus and text
  if (!widget.els.searchCard && !widget.noSearch) {
    const card = el("div", "shoutbox-side__card shoutbox-side__card--search");
    const box = el("div", "shoutbox-side__search");
    const icon = el("span", "shoutbox-side__search-icon");
    icon.innerHTML = iconHTML("search");
    const input = el("input", "shoutbox-side__search-input");
    input.type = "search";
    input.placeholder = i18n("shoutbox.side_search");
    input.addEventListener("input", () => {
      searchQuery = input.value;
      widgets.forEach(applySearchFilter);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = "";
        searchQuery = "";
        widgets.forEach(applySearchFilter);
      }
    });
    box.appendChild(icon);
    box.appendChild(input);
    card.appendChild(box);
    widget.els.searchCard = card;
  }

  // "What's new": latest moments as one-line excerpts, click jumps to the row
  const latest = [...messages.values()]
    .filter((m) => !m.reply_to_id)
    .sort((a, b) => b.id - a.id);
  const whatsNew = el("div", "shoutbox-side__card");
  whatsNew.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_whats_new")));
  const shown = latest.slice(0, whatsNewExpanded ? 20 : 5);
  if (shown.length === 0) {
    whatsNew.appendChild(el("div", "shoutbox-side__text", i18n("shoutbox.empty")));
  } else {
    shown.forEach((m) => {
      const row = el("button", "shoutbox-side__excerpt-row");
      row.type = "button";
      const main = el("div", "shoutbox-side__excerpt-main");
      main.appendChild(
        el(
          "div",
          "shoutbox-side__excerpt-meta",
          i18n("shoutbox.side_from", { username: m.user?.username || "?" }),
        ),
      );
      const excerpt = el("div", "shoutbox-side__excerpt");
      appendExcerptContent(excerpt, excerptFor(m) || i18n("shoutbox.side_photo"));
      main.appendChild(excerpt);
      row.appendChild(main);
      // trailing ⁝ appears on hover (memos-style)
      const dots = el("span", "shoutbox-side__excerpt-dots");
      dots.innerHTML = iconHTML("ellipsis-vertical");
      row.appendChild(dots);
      row.addEventListener("click", () => jumpToMessage(widget, m.id));
      whatsNew.appendChild(row);
    });
    if (latest.length > 5) {
      const more = el("button", "shoutbox-side__more");
      more.type = "button";
      more.textContent = i18n(
        whatsNewExpanded ? "shoutbox.side_show_less" : "shoutbox.side_show_more",
      );
      more.addEventListener("click", () => {
        whatsNewExpanded = !whatsNewExpanded;
        widgets.forEach(renderSide);
      });
      whatsNew.appendChild(more);
    }
  }

  // suggested members: most active authors the viewer isn't
  const suggested = el("div", "shoutbox-side__card");
  suggested.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_suggested")));
  const recs = ranked
    .filter((e) => e.user?.username && e.user.username !== viewer?.username)
    .slice(0, 5);
  if (recs.length === 0) {
    suggested.appendChild(
      el("div", "shoutbox-side__text", i18n("shoutbox.side_suggested_empty")),
    );
  } else {
    recs.forEach(({ user }) => {
      const rowEl = el("div", "shoutbox-side__row");
      if (user?.avatar_template) {
        const img = el("img");
        img.src = user.avatar_template.replace("{size}", "48");
        img.alt = "";
        img.loading = "lazy";
        rowEl.appendChild(img);
      }
      const a = makeLink(`/u/${esc(user?.username).toLowerCase()}`, "shoutbox-side__name");
      a.textContent = esc(user?.username);
      rowEl.appendChild(a);
      rowEl.appendChild(buildFollowButton(user));
      suggested.appendChild(rowEl);
    });
    // one batched state fetch per session (user-cards carries is_followed)
    if (viewer?.signed_in && !followStateLoaded) {
      followStateLoaded = true;
      const ids = recs.map((r) => r.user?.id).filter(Boolean).join(",");
      if (ids) {
        ajax(`/user-cards.json?user_ids=${ids}`)
          .then((d) => {
            (d.users || []).forEach((u) => followState.set(u.username, !!u.is_followed));
            widgets.forEach(renderSide);
          })
          .catch(() => {});
      }
    }
    const more = makeLink("/u", "shoutbox-side__more");
    more.textContent = i18n("shoutbox.side_show_more");
    suggested.appendChild(more);
  }

  const active = el("div", "shoutbox-side__card");
  active.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_active")));
  if (top.length === 0) {
    active.appendChild(el("div", "shoutbox-side__text", i18n("shoutbox.empty")));
  } else {
    top.forEach(({ user, count }) => {
      const rowEl = el("div", "shoutbox-side__row");
      if (user?.avatar_template) {
        const img = el("img");
        img.src = user.avatar_template.replace("{size}", "48");
        img.alt = "";
        img.loading = "lazy";
        rowEl.appendChild(img);
      }
      const a = makeLink(`/u/${esc(user?.username).toLowerCase()}`, "shoutbox-side__name");
      a.textContent = esc(user?.username);
      rowEl.appendChild(a);
      rowEl.appendChild(
        el("span", "shoutbox-side__count", i18n("shoutbox.side_count", { n: count })),
      );
      active.appendChild(rowEl);
    });
  }

  const about = el("div", "shoutbox-side__card");
  about.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.title")));
  about.appendChild(
    el("p", "shoutbox-side__text", i18n("shoutbox.side_about", { n: messages.size })),
  );

  const cards = [
    ...(widget.noSearch ? [] : [widget.els.searchCard]),
    whatsNew,
    suggested,
  ];
  if (widget.els.tagsCard) {
    cards.push(widget.els.tagsCard);
  }
  cards.push(active, about);
  side.replaceChildren(...cards);
}

// One-line plain-text excerpt for the sidebar "What's new" rows.
function excerptFor(m) {
  return (m.message || "")
    .replace(/!\[[^\]\n]*\]\([^)\s]+[^)]*\)/g, "📷")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// Render excerpt text into a node, turning :emoji: shortcodes into tiny
// images via the shared emoji map (unknown codes stay as plain text).
function appendExcerptContent(parent, text) {
  const parts = text.split(/(:[a-zA-Z0-9_+-]+:)/g);
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const code = part.match(/^:([a-zA-Z0-9_+-]+):$/);
    const url = code && emojiMap?.get(code[1]);
    if (url) {
      const img = el("img", "shoutbox-side__emoji");
      img.src = url;
      img.alt = part;
      img.title = part;
      img.loading = "lazy";
      parent.appendChild(img);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

// Scroll a message row into view and flash it (sidebar What's-new clicks).
function jumpToMessage(widget, id) {
  const row = widget.els.list?.querySelector(`[data-id="${id}"]`);
  if (!row) {
    // no feed rows here (detail-page sidebar) — open the message's page
    DiscourseURL.routeTo(`/shoutbox/m/${id}`);
    return;
  }
  row.scrollIntoView({ block: "center" });
  row.classList.remove("shoutbox__item--new");
  void row.offsetWidth; // restart the animation
  row.classList.add("shoutbox__item--new");
}

// Hide feed rows that don't match the sidebar search box.
function applySearchFilter(widget) {
  const list = widget.els.list;
  if (!list) {
    return;
  }
  const q = searchQuery.trim().toLowerCase();
  let visible = 0;
  if (q) {
    list.querySelectorAll(".shoutbox__item").forEach((li) => {
      const m = messages.get(parseInt(li.dataset.id, 10));
      const hit = (m?.message || "").toLowerCase().includes(q);
      li.classList.toggle("shoutbox--hidden", !hit);
      if (hit) {
        visible++;
      }
    });
  } else {
    list
      .querySelectorAll(".shoutbox__item.shoutbox--hidden")
      .forEach((li) => li.classList.remove("shoutbox--hidden"));
  }
  let empty = widget.els.searchEmpty;
  if (!empty) {
    empty = el("li", "shoutbox__msg shoutbox__search-empty");
    widget.els.searchEmpty = empty;
  }
  empty.textContent = i18n("shoutbox.side_no_results");
  if (q && visible === 0) {
    if (!empty.isConnected) {
      list.appendChild(empty);
    }
    empty.hidden = false;
  } else {
    empty.hidden = true;
    empty.remove();
  }
}

function loadTagList() {
  tagListPromise ||= ajax("/shoutbox/tags.json")
    .then((d) => d.tags || [])
    .catch(() => []);
  return tagListPromise;
}

function fillTagsCard(widget) {
  const card = widget.els.tagsCard;
  if (!card) {
    return;
  }
  loadTagList().then((tags) => {
    if (widget.destroyed) {
      return;
    }
    card.hidden = tags.length === 0;
    const list = widget.els.tagsList;
    if (!list) {
      return;
    }
    list.replaceChildren();
    tags.forEach(({ name, count }) => {
      const a = makeLink(
        `/shoutbox?tag=${encodeURIComponent(name)}`,
        "shoutbox-side__tag"
      );
      a.textContent = `#${name}`;
      a.appendChild(el("span", "shoutbox-side__count", String(count)));
      list.appendChild(a);
    });
  });
}

function showEmptyStateIfNeeded(widget) {
  if (widget.els.list.children.length === 0) {
    widget.els.list.appendChild(el("li", "shoutbox__msg", i18n("shoutbox.empty")));
  }
}

function hideEmptyState(widget) {
  widget.els.list.querySelector(".shoutbox__msg")?.remove();
}

function renderFoot(widget) {
  const foot = widget.els.foot;

  // Rebuilding the composer on every poll would wipe drafts mid-typing — only
  // rebuild when the viewer's capabilities actually change.
  const sig = viewer ? `${viewer.signed_in}|${viewer.can_post}|${viewer.max_length}` : "";
  if (widget.els.footSig === sig) {
    return;
  }
  widget.els.footSig = sig;
  foot.replaceChildren();

  if (viewer && !viewer.signed_in) {
    const prompt = el("a", "shoutbox__login");
    prompt.href = "/login";
    prompt.textContent = i18n("shoutbox.login_prompt");
    foot.appendChild(prompt);
    return;
  }
  if (viewer && !viewer.can_post) {
    foot.appendChild(el("div", "shoutbox__login", i18n("shoutbox.not_allowed")));
    return;
  }

  const row = el("div", "shoutbox__composer-row");

  if (viewer?.avatar_template) {
    const av = el("img", "shoutbox__composer-avatar");
    av.src = viewer.avatar_template.replace("{size}", "96");
    av.alt = "";
    row.appendChild(av);
  }

  const col = el("div", "shoutbox__composer-col");

  const bar = el("div", "shoutbox__composer-bar");

  const ta = el("textarea", "shoutbox__composer");
  ta.rows = 1;
  ta.maxLength = viewer?.max_length || 200;
  ta.placeholder = i18n("shoutbox.placeholder");
  widget.els.composer = ta;
  col.appendChild(ta);
  makeAutoGrow(ta);

  // memos-style attachments strip between the textarea and the tool bar;
  // pending survives composer rebuilds (capability-gated)
  widget.els.pending = widget.els.pending || [];
  const attWrap = el("div", "shoutbox__attachments");
  attWrap.hidden = true;
  widget.els.attWrap = attWrap;
  col.appendChild(attWrap);

  const icons = buildComposerToolbar(ta, col, {
    pending: widget.els.pending,
    onUpload: () => {
      renderAttachments(widget);
      updateCount();
    },
  });
  bar.appendChild(icons);

  const actions = el("div", "shoutbox__composer-actions");
  const updateCount = () => {
    // pending attachments make Post available with an otherwise-empty text
    send.disabled =
      ta.value.trim().length === 0 &&
      !widget.els.pending.some((p) => p.status === "done");
  };
  

  const send = el("button", "shoutbox__send");
  send.type = "button";
  send.textContent = i18n("shoutbox.publish");
  send.disabled = true;
  widget.els.sendBtn = send;
  actions.appendChild(send);
  bar.appendChild(actions);

  col.appendChild(bar);
  row.appendChild(col);
  foot.appendChild(row);

  const mentionPop = widget.mountEl.querySelector(".shoutbox__mention-pop");
  let mentionSeq = 0;
  let mentionItems = [];
  let mentionIndex = -1;

  const closeMention = () => {
    mentionPop.hidden = true;
    mentionItems = [];
    mentionIndex = -1;
  };
  const highlightMention = () => {
    mentionItems.forEach((item, i) => item.classList.toggle("is-active", i === mentionIndex));
  };

  const applyMention = () => {
    const item = mentionItems[mentionIndex];
    if (!item) {
      return;
    }
    const username = item.dataset.username;
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos).replace(/@[a-zA-Z0-9_.-]*$/, `@${username} `);
    ta.value = before + ta.value.slice(pos);
    closeMention();
    ta.focus();
  };

  const refreshMentions = () => {
    const pos = ta.selectionStart ?? ta.value.length;
    const term = ta.value.slice(0, pos).match(/@([a-zA-Z0-9_.-]*)$/)?.[1];
    if (term === null || term === undefined) {
      closeMention();
      return;
    }
    const seq = ++mentionSeq;
    ajax(`/u/search/users.json?term=${encodeURIComponent(term)}&include_groups=false`)
      .then((data) => {
        if (seq !== mentionSeq || widget.destroyed) {
          return;
        }
        mentionItems.forEach((item) => item.remove());
        mentionItems = (data.users || []).slice(0, 6).map((user) => {
          const item = el("button", "shoutbox__mention-option");
          item.type = "button";
          item.dataset.username = user.username;

          const img = el("img");
          img.src = (user.avatar_template || "").replace("{size}", "48");
          img.alt = "";
          item.appendChild(img);

          const wrap = el("span");
          wrap.appendChild(el("b", null, user.username));
          if (user.name) {
            wrap.appendChild(el("small", null, user.name));
          }
          item.appendChild(wrap);

          item.addEventListener("click", applyMention);
          mentionPop.appendChild(item);
          return item;
        });
        mentionIndex = mentionItems.length ? 0 : -1;
        highlightMention();
        mentionPop.hidden = mentionItems.length === 0;
      })
      .catch(closeMention);
  };

  ta.addEventListener("input", () => {
    updateCount();
    refreshMentions();
  });
  ta.addEventListener("click", closeMention);
  ta.addEventListener("blur", () => setTimeout(closeMention, 150));
  ta.addEventListener("keydown", (event) => {
    if (!mentionPop.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (mentionItems.length) {
          mentionIndex =
            (mentionIndex + (event.key === "ArrowDown" ? 1 : mentionItems.length - 1)) %
            mentionItems.length;
          highlightMention();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applyMention();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault();
      submit(widget);
    } else if (event.key === "Escape") {
      ta.blur();
    }
  });

  send.addEventListener("click", () => submit(widget));
}

function submit(widget) {
  const ta = widget.els.composer;
  const send = widget.els.sendBtn;
  // attachments (memos-style) join the message as image markdown lines
  const attachMd = (widget.els.pending || [])
    .filter((p) => p.status === "done" && p.short_url)
    .map((p) => `\n![${p.name.replace(/\.[^.]+$/, "").slice(0, 60) || "image"}](${p.short_url})`)
    .join("");
  const text = (ta.value.trim() + attachMd).trim();
  if (!text || send.disabled) {
    return;
  }
  send.disabled = true;
  send.textContent = i18n("shoutbox.posting");

  const req = ajax("/shoutbox/messages.json", { type: "POST", data: { message: text } });

  req.then((payload) => {
      ta.value = "";
      ta.dispatchEvent(new Event("input"));
      widget.els.pending = [];
      renderAttachments(widget);
      if (payload?.message) {
        const m = payload.message;
        const isNew = !messages.has(m.id);
        messages.set(m.id, m);
        if (isNew) {
          lastSeenId = Math.max(lastSeenId, m.id);
          widgets.forEach((w) => w.appendRow(m, { isNew: true, forceScroll: true }));
        } else {
          widgets.forEach((w) => w.updateRow(m));
        }
      }
    })
    .catch((err) => {
      const msg =
        err?.jqXHR?.responseJSON?.errors?.[0] ||
        (err?.jqXHR?.status === 429 ? i18n("shoutbox.rate_limited") : i18n("shoutbox.send_failed"));
      window.alert(msg);
    })
    .finally(() => {
      send.textContent = i18n("shoutbox.publish");
      const visible = ta.value.replace(IMAGE_MD_RE_G, "");
      send.disabled =
        visible.trim().length === 0 &&
        !(widget.els.pending || []).some((p) => p.status === "done");
      ta.focus();
    });
}

function buildPopovers(widget) {
  const wrap = el("div", "shoutbox__popovers");
  const emojiPop = el("div", "shoutbox__emoji-pop");
  emojiPop.hidden = true;
  const mentionPop = el("div", "shoutbox__mention-pop");
  mentionPop.hidden = true;
  const composePop = el("div", "shoutbox__compose-pop");
  composePop.hidden = true;
  widget.els.composePop = composePop;
  wrap.appendChild(emojiPop);
  wrap.appendChild(mentionPop);
  wrap.appendChild(composePop);

  widget.mountEl.addEventListener("click", (event) => {
    if (
      !emojiPop.hidden &&
      !event.target.closest(".shoutbox__emoji-pop") &&
      !event.target.closest(".shoutbox__emoji-btn")
    ) {
      emojiPop.hidden = true;
    }
    if (
      !composePop.hidden &&
      !event.target.closest(".shoutbox__compose-pop") &&
      !event.target.closest(".shoutbox__compose-toggle")
    ) {
      composePop.hidden = true;
    }
  });

  return wrap;
}

// ── per-message detail page (/shoutbox/m/:id) ────────────────────────────────
// Memos-style: back link, the message card, then its comments with a compose
// box. Standalone from the feed widgets — data comes from the show endpoint.

function buildDetailReply(m, onReply) {
  const row = el("div", "shoutbox__detail-reply");
  if (m.user?.avatar_template) {
    const img = el("img", "shoutbox__detail-reply-avatar");
    img.src = m.user.avatar_template.replace("{size}", "48");
    img.alt = "";
    img.loading = "lazy";
    row.appendChild(img);
  }
  const main = el("div", "shoutbox__detail-reply-main");
  const meta = el("div", "shoutbox__detail-reply-meta");
  const a = makeLink(userHref(m), "shoutbox__detail-reply-name");
  a.textContent = m.user?.name || m.user?.username || "?";
  meta.appendChild(a);
  meta.appendChild(el("span", "shoutbox__detail-reply-handle", `@${m.user?.username || "?"}`));
  const date = new Date(m.created_at);
  if (!isNaN(date.getTime())) {
    const time = el("span", "shoutbox__detail-reply-time");
    time.textContent = relativeAge(date, { format: "tiny" });
    time.title = date.toLocaleString();
    meta.appendChild(time);
  }
  // reply to THIS comment — opens the same modal with the comment as target
  if (onReply && viewer?.signed_in) {
    const btn = el("button", "shoutbox__detail-reply-btn");
    btn.type = "button";
    btn.title = i18n("shoutbox.reply_send");
    btn.setAttribute("aria-label", i18n("shoutbox.reply_send"));
    btn.innerHTML = iconHTML("far-comment");
    btn.addEventListener("click", () => onReply(m));
    meta.appendChild(btn);
  }
  main.appendChild(meta);
  const text = el("div", "shoutbox__detail-reply-text");
  renderRichText(text, m.message || "");
  main.appendChild(text);
  row.appendChild(main);
  return row;
}

export function mountShoutboxDetail(rootEl, { id }) {
  const state = { destroyed: false };
  id = Number(id);

  // two-column layout like the feed page: detail column + the same sidebar
  // widgets (What's new / Suggested / Tags / Most active / About)
  rootEl.classList.add("shoutbox-page-grid");
  const wrap = el("div", "shoutbox-detail");
  rootEl.appendChild(wrap);
  const side = el("aside", "shoutbox-side");
  rootEl.appendChild(side);
  const sideWidget = {
    rootEl,
    variant: "detail",
    els: { side },
    noSearch: true, // the feed-side search has no feed to filter here
    destroyed: false,
    // registered in the shared widgets set, so bus events and the 60s poll
    // will call the feed widget API on it — these are intentional no-ops
    refresh: () => {},
    appendRow: () => {},
    insertReplyRow: () => {},
    updateRow: () => {},
    removeRow: () => {},
    showError: () => {},
  };
  const tagsCard = el("div", "shoutbox-side__card shoutbox-side__card--tags");
  tagsCard.hidden = true;
  tagsCard.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_tags")));
  sideWidget.els.tagsList = el("div", "shoutbox-side__tag-list");
  tagsCard.appendChild(sideWidget.els.tagsList);
  sideWidget.els.tagsCard = tagsCard;
  side.appendChild(tagsCard);
  widgets.add(sideWidget);

  // invalid/missing id (bad URL) — render the failure state, skip the fetch
  if (!Number.isFinite(id) || id <= 0) {
    const failCard = el("div", "shoutbox-detail__fail");
    failCard.appendChild(el("li", "shoutbox__msg", i18n("shoutbox.load_failed")));
    wrap.appendChild(failCard);
    return { rootEl, destroy: () => (state.destroyed = true) };
  }

  // X-style header: back arrow + page title
  const header = el("div", "shoutbox-detail__header");
  const back = el("a", "shoutbox-detail__back");
  back.href = "/shoutbox";
  back.title = i18n("shoutbox.detail_back");
  back.setAttribute("aria-label", i18n("shoutbox.detail_back"));
  back.innerHTML = iconHTML("arrow-left");
  header.appendChild(back);
  header.appendChild(el("span", "shoutbox-detail__heading", i18n("shoutbox.detail_heading")));
  wrap.appendChild(header);

  // parent message — borderless block, X-style
  const parent = el("article", "shoutbox-detail__parent");
  parent.appendChild(el("li", "shoutbox__msg", "\u2026"));
  wrap.appendChild(parent);

  // reply compose row sits ABOVE the comment list, like X's detail page
  const compose = el("div", "shoutbox__detail-compose");
  compose.hidden = true;
  const cAvatar = el("img", "shoutbox__detail-compose-avatar");
  cAvatar.alt = "";
  const ta = el("textarea", "shoutbox__comment-input");
  ta.rows = 1;
  ta.maxLength = 200;
  ta.placeholder = i18n("shoutbox.comment_placeholder");
  const growTa = makeAutoGrow(ta);

  // the same compose anatomy as the modal: avatar + column with the input,
  // pending-image previews and the full toolbar; Post on the right
  const col = el("div", "shoutbox__reply-col");
  col.appendChild(ta);

  const pending = [];
  const attWrap = el("div", "shoutbox__attachments");
  attWrap.hidden = true;
  col.appendChild(attWrap);

  const bar = el("div", "shoutbox__reply-bar");
  const icons = buildComposerToolbar(ta, col, {
    pending,
    onUpload: () => {
      renderPendingAttachments(attWrap, pending, update);
      update();
    },
  });
  bar.appendChild(icons);

  const actions = el("div", "shoutbox__composer-actions");
  const publish = el("button", "shoutbox__send");
  publish.type = "button";
  publish.textContent = i18n("shoutbox.publish");
  publish.disabled = true;
  actions.appendChild(publish);
  bar.appendChild(actions);

  col.appendChild(bar);
  compose.appendChild(cAvatar);
  compose.appendChild(col);
  wrap.appendChild(compose);

  // replies render below the compose row
  const listEl = el("div", "shoutbox__detail-list");
  wrap.appendChild(listEl);

  const update = () => {
    publish.disabled =
      ta.value.trim().length === 0 && !pending.some((p) => p.status === "done");
  };
  update();
  ta.addEventListener("input", update);

  const appendReply = (r) => {
    listEl.querySelector(".shoutbox__detail-empty")?.remove();
    listEl.appendChild(buildDetailReply(r));
    listEl.scrollTop = listEl.scrollHeight;
  };

  publish.addEventListener("click", () => {
    const attachMd = pending
      .filter((p) => p.status === "done" && p.short_url)
      .map(
        (p) =>
          `\n![${p.name.replace(/\.[^.]+$/, "").slice(0, 60) || "image"}](${p.short_url})`,
      )
      .join("");
    const text = (ta.value.trim() + attachMd).trim();
    if (!text || publish.disabled) {
      return;
    }
    publish.disabled = true;
    publish.textContent = i18n("shoutbox.posting");
    ajax("/shoutbox/messages.json", {
      type: "POST",
      data: { message: text, reply_to_id: id },
    })
      .then((payload) => {
        ta.value = "";
        pending.length = 0;
        renderPendingAttachments(attWrap, pending, update);
        update();
        if (payload?.message) {
          // instant apply with the same card anatomy as the list — the old
          // appendReply rendered the legacy row style
          applyNewReply(payload.message);
        }
        publish.disabled = false;
        publish.textContent = i18n("shoutbox.publish");
        ta.focus();
      })
      .catch((err) => {
        publish.disabled = false;
        publish.textContent = i18n("shoutbox.publish");
        window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
      });
  });

  ta.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault();
      if (!publish.disabled) {
        publish.click();
      }
    }
  });

  // sidebar data: recent messages + viewer (independent of the detail fetch)
  ajax("/shoutbox/messages.json")
    .then((payload) => {
      if (state.destroyed) {
        return;
      }
      viewer = payload.viewer || viewer;
      (payload.messages || []).forEach((m) => {
        if (!messages.has(m.id)) {
          messages.set(m.id, m);
        }
      });
      renderSide(sideWidget);
      fillTagsCard(sideWidget);
    })
    .catch(() => {});

  let current = null; // the loaded message (fresh after edit / pin)

  const renderParent = () => {
    if (state.destroyed || !current) {
      return;
    }
    const m = current;
    parent.replaceChildren();

    const grid = el("div", "shoutbox__card-main");
    if (m.user?.avatar_template) {
      const img = el("img", "shoutbox-detail__avatar");
      img.src = m.user.avatar_template.replace("{size}", "96");
      img.alt = "";
      img.loading = "lazy";
      grid.appendChild(img);
    }
    const cardCol = el("div", "shoutbox__card-main-col");
    const who = el("div", "shoutbox-detail__who");
    const name = makeLink(userHref(m), "shoutbox-detail__name");
    name.textContent = m.user?.name || m.user?.username || "?";
    who.appendChild(name);
    who.appendChild(el("span", "shoutbox-detail__handle", `@${m.user?.username || "?"}`));

    // top-right menu: edit / delete / pin / copy link
    const menuBtn = el("button", "jt-card__peek btn btn-flat no-text");
    menuBtn.type = "button";
    menuBtn.title = i18n("shoutbox.menu");
    menuBtn.setAttribute("aria-label", i18n("shoutbox.menu"));
    menuBtn.innerHTML = iconHTML("ellipsis-vertical");
    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      who.querySelector(":scope > .shoutbox__menu")?.remove();
      const menu = el("div", "shoutbox__menu");
      const add = (label, cls, fn) => {
        const b = el("button", "shoutbox__menu-item" + (cls ? " " + cls : ""));
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          menu.remove();
          document.removeEventListener("click", close);
          fn();
        });
        menu.appendChild(b);
      };
      if (m.can_edit) {
        add(i18n("shoutbox.edit"), "", () => {
          if (editing) {
            return;
          }
          const images = [
            ...m.message.matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g),
          ];
          editing = {
            id: m.id,
            text: m.message
              .replace(IMAGE_MD_RE_G, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim(),
            pending: images.map((g, i) => ({
              id: `edit-${g[1] || i}`,
              name: g[1] || "image",
              status: "done",
              short_url: g[2],
            })),
          };
          renderParent();
        });
      }
      if (m.can_delete) {
        add(i18n("shoutbox.delete"), "is-danger", () => {
          if (!window.confirm(i18n("shoutbox.confirm_delete"))) {
            return;
          }
          ajax(`/shoutbox/messages/${m.id}.json`, { type: "DELETE" }).then(() =>
            DiscourseURL.routeTo("/shoutbox"),
          );
        });
      }
      if (viewer?.staff) {
        add(
          i18n(m.pinned ? "shoutbox.unpin" : "shoutbox.pin"),
          "",
          () => {
            ajax(`/shoutbox/messages/${m.id}/pin`, { type: "POST" }).then(() => {
              current = { ...current, pinned: !current.pinned };
              renderParent();
            });
          },
        );
      }
      add(i18n("shoutbox.copy_link"), "", () => {
        const url = `${window.location.origin}/shoutbox/m/${m.id}`;
        navigator.clipboard?.writeText(url);
        window.alert(i18n("shoutbox.copied"));
      });
      who.appendChild(menu);
      const close = (event) => {
        if (!who.contains(event.target)) {
          menu.remove();
          document.removeEventListener("click", close);
        }
      };
      setTimeout(() => document.addEventListener("click", close), 0);
    });
    who.appendChild(menuBtn);
    cardCol.appendChild(who);

    if (editing && editing.id === m.id) {
      // in-place editor — same toolbar and previews as the feed editor
      const ta = el("textarea", "shoutbox__edit-input");
      ta.value = editing.text;
      ta.maxLength = viewer?.max_length || 200;
      ta.rows = 3;
      makeAutoGrow(ta);
      ta.addEventListener("input", () => {
        editing.text = ta.value;
      });
      const renderGrid = () =>
        renderPendingAttachments(attWrap, editing.pending, null);
      const attWrap = el("div", "shoutbox__attachments");
      cardCol.appendChild(attWrap);
      renderGrid();

      const bar = el("div", "shoutbox__edit-bar");
      const icons = buildComposerToolbar(ta, cardCol, {
        pending: editing.pending,
        onUpload: renderGrid,
      });
      bar.appendChild(icons);

      const actions = el("div", "shoutbox__edit-actions");
      const cancelBtn = el("button", "shoutbox__edit-cancel");
      cancelBtn.type = "button";
      cancelBtn.textContent = i18n("shoutbox.cancel");
      cancelBtn.addEventListener("click", () => {
        editing = null;
        renderParent();
      });
      actions.appendChild(cancelBtn);

      const saveBtn = el("button", "shoutbox__send shoutbox__edit-save");
      saveBtn.type = "button";
      saveBtn.textContent = i18n("shoutbox.save");
      saveBtn.addEventListener("click", () => {
        const attachMd = editing.pending
          .filter((p) => p.status === "done" && p.short_url)
          .map(
            (p) =>
              `\n![${p.name.replace(/\.[^.]+$/, "").slice(0, 60) || "image"}](${p.short_url})`,
          )
          .join("");
        const text = (ta.value.trim() + attachMd).trim();
        if (!text) {
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = i18n("shoutbox.posting");
        ajax(`/shoutbox/messages/${editing.id}.json`, {
          type: "PUT",
          data: { message: text },
        })
          .then((payload) => {
            if (payload?.message) {
              messages.set(payload.message.id, payload.message);
              current = payload.message;
            }
            editing = null;
            renderParent();
          })
          .catch((err) => {
            saveBtn.disabled = false;
            saveBtn.textContent = i18n("shoutbox.save");
            window.alert(
              err?.jqXHR?.responseJSON?.errors?.[0] ||
                i18n("shoutbox.send_failed"),
            );
          });
      });
      actions.appendChild(saveBtn);
      bar.appendChild(actions);
      cardCol.appendChild(bar);

      grid.appendChild(cardCol);
      parent.appendChild(grid);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }

    const content = el("div", "shoutbox-detail__content");
    renderRichText(content, m.message || "");
    cardCol.appendChild(content);
    grid.appendChild(cardCol);

    // media breakout: full parent-card width, under the avatar axis
    const dm = content.querySelector(".shoutbox__media");
    if (dm) {
      parent.appendChild(dm);
    }

    parent.appendChild(grid);

    // X-style stats strip: comment (opens the reply modal), like, views,
    // then the publish time — matching the feed card's stat order
    const stats = el("div", "shoutbox-detail__stats");
    const stat = (icon, n, title) => {
      const s = el("span", "shoutbox-detail__stat");
      s.title = title;
      s.innerHTML = iconHTML(icon) + `<span class="number">${n || 0}</span>`;
      return s;
    };
    const cBtn = el("button", "shoutbox-detail__stat shoutbox__comment-stat");
    cBtn.type = "button";
    cBtn.title = i18n("shoutbox.comment");
    cBtn.setAttribute("aria-label", i18n("shoutbox.comment"));
    cBtn.innerHTML =
      iconHTML("far-comment") + `<span class="number">${m.reply_count || 0}</span>`;
    cBtn.addEventListener("click", () => openReplyModal(null, m));
    stats.appendChild(cBtn);
    stats.appendChild(stat("heart", m.like_count, i18n("shoutbox.like")));
    stats.appendChild(
      stat("far-eye", m.views, i18n("shoutbox.views", { n: m.views || 0 })),
    );
    const date = new Date(m.created_at);
    if (!isNaN(date.getTime())) {
      const activity = el("span", "shoutbox-detail__stat --activity");
      const time = el("span", "relative-date");
      time.textContent = relativeAge(date, { format: "tiny" });
      time.title = date.toLocaleString();
      activity.appendChild(time);
      stats.appendChild(activity);
    }
    parent.appendChild(stats);
  };

  // buildRow (used for reply cards) expects the feed widget API — provide a
  // detail-scoped stub: re-renders the tree instead of touching a feed list
  // buildRow (used for reply cards) expects the feed widget API — the detail
  // widget implements the slice of it that bus events and the POST-response
  // path (applyNewReply) need, so the conversation updates INSTANTLY like a
  // core post page instead of waiting for a manual refresh
  const widget = {
    rootEl,
    variant: "detail",
    els: { side, list: listEl },
    destroyed: false,
    refresh: () => {},
    appendRow: () => {},
    // a new reply landed whose parent is inside THIS conversation — insert
    // the card in place when its branch is visible, otherwise just refresh
    // the collapsed toggle's count. The caller (bus handler or
    // applyNewReply) has ALREADY bumped the parent's reply_count on the
    // shared message object — this must not bump it again.
    insertReplyRow: (m) => {
      if (state.destroyed || !m?.reply_to_id) {
        return;
      }
      const rootId = Number(id);
      const isRootReply = m.reply_to_id === rootId;
      const parentRow = isRootReply
        ? null
        : currentReplies.find((r) => r.id === m.reply_to_id);
      if (!isRootReply && !parentRow) {
        return; // reply to something outside this conversation
      }
      if (currentReplies.some((r) => r.id === m.id)) {
        return; // bus echo after the POST-path insert
      }
      currentReplies.push(m);
      if (!messages.has(m.id)) {
        messages.set(m.id, m);
      }
      const pm = isRootReply ? current : parentRow;
      if (isRootReply) {
        // the root card lives outside the list — bump its stat directly
        const stat = parent.querySelector(".shoutbox__comment-stat .number");
        if (stat && pm) {
          stat.textContent = String(pm.reply_count);
        }
        // newest direct comment = largest id = last position in the list
        const li = buildRow(widget, m, {});
        li.classList.add("shoutbox__reply-l1");
        li.style.marginLeft = "0";
        listEl.querySelector(":scope > .shoutbox__detail-children")?.appendChild(
          li,
        );
        return;
      }
      const li0 = rootEl.querySelector(`[data-id="${m.reply_to_id}"]`);
      const toggle = li0?.nextElementSibling;
      const branch =
        toggle?.classList?.contains("shoutbox__replies-more") &&
        toggle.nextElementSibling?.classList?.contains("shoutbox__replies-branch")
          ? toggle.nextElementSibling
          : null;
      if (branch) {
        const li = buildRow(widget, m, {});
        li.classList.add("shoutbox__reply-l2");
        li.style.marginLeft = "0";
        branch.appendChild(li);
      } else if (toggle) {
        // branch collapsed — the card will appear when it's expanded
        toggle.textContent = i18n("shoutbox.show_replies", {
          n: pm ? pm.reply_count : 1,
        });
      }
    },
    // an edited message: replace the row in place, keep its depth class
    updateRow: (m) => {
      if (state.destroyed || !m) {
        return;
      }
      if (m.id === Number(id)) {
        current = m;
        renderParent();
        return;
      }
      const r = currentReplies.find((x) => x.id === m.id);
      if (!r) {
        return;
      }
      Object.assign(r, m);
      const old = listEl.querySelector(`[data-id="${m.id}"]`);
      if (old) {
        const li = buildRow(widget, m, {});
        li.classList.add(
          old.classList.contains("shoutbox__reply-l2")
            ? "shoutbox__reply-l2"
            : "shoutbox__reply-l1",
        );
        li.style.marginLeft = "0";
        old.replaceWith(li);
      }
    },
    // a deleted message: drop the row, its toggle and its visible branch
    removeRow: (mid) => {
      const idx = currentReplies.findIndex((r) => r.id === mid);
      if (idx >= 0) {
        currentReplies.splice(idx, 1);
      }
      const row = listEl.querySelector(`[data-id="${mid}"]`);
      if (row) {
        const sib = row.nextElementSibling;
        if (sib?.classList?.contains("shoutbox__replies-more")) {
          const branch = sib.nextElementSibling;
          sib.remove();
          if (branch?.classList?.contains("shoutbox__replies-branch")) {
            branch.remove();
          }
        }
        row.remove();
      }
    },
    // the parent card's like count lives outside the list — re-render it
    onBusLike: (data) => {
      if (state.destroyed || data.id !== Number(id) || !current) {
        return;
      }
      current.like_count = data.like_count;
      current.liked = data.liked;
      renderParent();
    },
    showError: () => {},
  };

  let currentReplies = [];
  // ids of comments whose replies branch is expanded — lives across
  // renderReplyList calls so bus-driven re-renders keep branches open
  const expandedBranches = new Set();

  // ONE card holds the whole conversation: the parent message (a full
  // buildRow card) with its DIRECT comments embedded inside it as
  // divider-separated rows — flat, one level only. Deeper replies stay
  // folded behind X-style "Show replies (N)" rows (one per comment,
  // expanding in place, level by level); card clicks keep navigating to a
  // comment's own page as the jump-straight-in path.
  const renderReplyList = (replies) => {
    currentReplies = replies;
    listEl.replaceChildren();
    if (replies.length === 0) {
      listEl.appendChild(
        el("div", "shoutbox__detail-empty", i18n("shoutbox.detail_empty")),
      );
      return;
    }
    // X-style "show replies": DIRECT comments render flat; any comment that
    // holds its own replies keeps them folded behind a "Show replies (N)"
    // row — clicking expands that branch IN PLACE, one level per expansion,
    // and each deeper level gets its own toggle. A reply whose own parent is
    // missing from the payload (deleted mid-tree) still shows as a root
    // rather than vanishing. The parent message itself is rendered once by
    // renderParent() above — the list holds comments ONLY (no parent copy).
    const kids = new Map();
    const roots = [];
    for (const r of replies) {
      if (r.reply_to_id === Number(id) || !replies.some((x) => x.id === r.reply_to_id)) {
        roots.push(r);
      } else {
        const arr = kids.get(r.reply_to_id) || [];
        arr.push(r);
        kids.set(r.reply_to_id, arr);
      }
    }
    const wrap = el("div", "shoutbox__detail-children");

    // one toggle row under a comment card: collapsed = "Show replies (N)",
    // expanded = "Hide replies" — the branch is built/removed in place, no
    // full re-render (and no scroll jump)
    const buildToggle = (m) => {
      const kidCount = (kids.get(m.id) || []).length;
      if (!kidCount) {
        return null;
      }
      const row = el("button", "shoutbox__replies-more");
      row.type = "button";
      const setLabel = () => {
        row.textContent = expandedBranches.has(m.id)
          ? i18n("shoutbox.hide_replies")
          : i18n("shoutbox.show_replies", { n: kidCount });
      };
      setLabel();
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expandedBranches.has(m.id)) {
          expandedBranches.delete(m.id);
          row.nextElementSibling?.remove();
        } else {
          expandedBranches.add(m.id);
          const branch = el("div", "shoutbox__replies-branch");
          fillBranch(m.id, branch);
          row.after(branch);
        }
        setLabel();
      });
      return row;
    };

    // branch container — the indent is set INLINE on purpose: theme CSS
    // boxes load after plugin CSS and stomp margins, so the reply
    // indentation the user asked for must not live in the cascade
    const makeBranch = () => {
      const branch = el("div", "shoutbox__replies-branch");
      branch.style.marginLeft = "1.6em";
      branch.style.paddingLeft = "0.7em";
      return branch;
    };

    // one expanded level: every child card gets the indented l2 treatment
    // and the "Replying to @who" tag (they are answering someone specific);
    // children with their own replies carry the next toggle row
    const fillBranch = (parentId, container) => {
      for (const c of kids.get(parentId) || []) {
        const li = buildRow(widget, c, {});
        li.classList.add("shoutbox__reply-l2");
        // the branch container owns the indent (1.6em inline per level) —
        // zero the card's own --reply margin so depth stacks cleanly
        li.style.marginLeft = "0";
        container.appendChild(li);
        const toggle = buildToggle(c);
        if (toggle) {
          container.appendChild(toggle);
          if (expandedBranches.has(c.id)) {
            const branch = makeBranch();
            fillBranch(c.id, branch);
            toggle.after(branch);
          }
        }
      }
    };

    for (const r of roots) {
      const li = buildRow(widget, r, {});
      li.classList.add("shoutbox__reply-l1");
      // direct comments sit FLUSH — buildRow's --reply indent (meant for the
      // old nested look) would invert the hierarchy now that the branch
      // containers indent replies instead; inline beats any cascade
      li.style.marginLeft = "0";
      wrap.appendChild(li);
      const toggle = buildToggle(r);
      if (toggle) {
        wrap.appendChild(toggle);
        if (expandedBranches.has(r.id)) {
          const branch = makeBranch();
          fillBranch(r.id, branch);
          toggle.after(branch);
        }
      }
    }
    listEl.appendChild(wrap);
  };

  const fullRefresh = () => {
    ajax(`/shoutbox/messages/${id}.json`)
      .then((payload) => {
        if (state.destroyed) {
          return;
        }
        viewer = payload.viewer || viewer;
        if (payload.viewer?.can_post) {
          compose.hidden = false;
          if (payload.viewer.avatar_template) {
            cAvatar.src = payload.viewer.avatar_template.replace("{size}", "48");
          }
          // the mount-time autogrow pass measured the hidden box (height 1px)
          requestAnimationFrame(growTa);
        }
        current = payload.message;
        // register the whole conversation in the shared messages map — bus
        // events (likes/edits/replies) can then find their parents and
        // dedupe against what's on screen; the fetch objects STAY the map
        // objects so bus mutations are visible to the render closures
        if (current) {
          messages.set(current.id, current);
        }
        (payload.replies || []).forEach((m) => messages.set(m.id, m));
        renderParent();

        renderReplyList(payload.replies || []);
      })
      .catch(() => {
        if (!state.destroyed) {
          parent.replaceChildren(
            el("li", "shoutbox__msg", i18n("shoutbox.load_failed")),
          );
        }
      });
  };

  fullRefresh();

  return {
    rootEl,
    destroy: () => {
      state.destroyed = true;
      widgets.delete(sideWidget);
      rootEl.classList.remove("shoutbox-page-grid");
    },
  };
}

export function unmountShoutboxDetail(widget) {
  widget?.destroy?.();
  if (widget?.rootEl) {
    widget.rootEl.replaceChildren();
  }
}
