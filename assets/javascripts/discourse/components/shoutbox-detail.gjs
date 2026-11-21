import Component from "@glimmer/component";
import { service } from "@ember/service";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import { mountShoutboxDetail, unmountShoutboxDetail } from "../lib/shoutbox-widget";

export default class ShoutboxDetail extends Component {
  @service router;
  widget = null;
  currentId = null;
  element = null;

  mount = (element) => {
    this.element = element;
    this.mountForUrl();
    // The component instance SURVIVES a /m/:id -> /m/:id navigation (same
    // route re-entry, args unchanged), so didInsert alone leaves the previous
    // message's widget on screen — the card click would only swap the URL
    // while the content stayed stale. Re-mount on every route change; the
    // id guard keeps unrelated navigations and repeats as no-ops.
    this._routeChanged = () => this.mountForUrl();
    this.router.on("routeDidChange", this._routeChanged);
  };

  mountForUrl = () => {
    if (!this.element) {
      return;
    }
    // read the id straight from the URL — route-model plumbing through gjs
    // template args proved unreliable (arrived undefined -> NaN.json)
    const id = Number(window.location.pathname.match(/\/shoutbox\/m\/(\d+)/)?.[1]);
    if (!Number.isFinite(id) || id <= 0 || id === this.currentId) {
      return;
    }
    this.currentId = id;
    if (this.widget) {
      unmountShoutboxDetail(this.widget);
    }
    this.widget = mountShoutboxDetail(this.element, { id });
  };

  unmount = () => {
    this.router.off("routeDidChange", this._routeChanged);
    unmountShoutboxDetail(this.widget);
    this.widget = null;
  };

  <template>
    <div class="shoutbox-detail-wrap" {{didInsert this.mount}} {{willDestroy this.unmount}}></div>
  </template>
}
