# discourse-shoutbox

A real message board (shoutbox) for Discourse — memos/X-style: short messages,
replies with lineage, likes, pins, #tags, image uploads, live updates via
MessageBus. Flexible placement: a homepage panel above the topic list, a
sidebar community-section link to the full `/shoutbox` page, and a
`[data-shoutbox-mount]` contract for arbitrary placements.

## Install

Add the clone step to your `app.yml` after_code hooks:

```yaml
hooks:
  after_code:
    - exec:
        cd: $home/plugins
        cmd:
          - git clone https://github.com/gchongo/discourse-shoutbox.git
```

Then `./launcher rebuild app`.

Enable it at Settings → `shoutbox_enabled` (the admin page lives at
/admin/plugins/discourse-shoutbox).

## Coming from the jtechtools bundle

The plugin was extracted from the jtechtools bundle; this standalone version:

- owns the same migrations (identical timestamps — installs that ran the
  bundle's copy skip them and keep every message)
- registers the same setting names (shoutbox_enabled, shoutbox_max_length, …)
  so stored values carry over — but no longer depends on `jtech_enabled`
- serves its admin settings at the standard /admin/plugins/discourse-shoutbox
  page (the bundle's custom admin tab is gone)

## Deploy note

Plugin JS is compiled through Discourse's AssetProcessor, which caches builds
under `tmp/asset-processor` keyed by dependency globs. If a deploy ever serves
stale JS, clear that cache inside the container and re-run the precompile —
or just rebuild the app.

## Placement contract

Any theme or component can mount a read-only panel:

```html
<div data-shoutbox-mount></div>
```

The initializer fills it with the board (homepage panel and sidebar link are
controlled by the shoutbox_homepage_panel / shoutbox_sidebar_link settings).
