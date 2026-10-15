import { createRoot, type Root } from "react-dom/client";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { EndorsementBadge } from "../../components/EndorsementBadge.js";
import { createBadgeController } from "../../lib/badge-controller.js";
import type { RepoRef } from "../../lib/github.js";
import type { IsStale } from "../../lib/latest-only.js";
// With `cssInjectionMode: "ui"` WXT bundles this CSS and loads it into the
// shadow root for us, so the sheet must not be imported as an inline string.
import "./styles.css";

export default defineContentScript({
  // Scoped to github.com; the script no-ops on non-repository pages, but a
  // narrow match keeps it off profile and search pages entirely.
  matches: ["https://github.com/*"],
  cssInjectionMode: "ui",

  async main(ctx) {
    const controller = createBadgeController<ShadowRootContentScriptUi<Root>>(
      (repo, isStale) => mount(ctx, repo, isStale),
    );
    ctx.onInvalidated(() => controller.dispose());

    // The listener is registered before the first badge so that a script which
    // starts on a profile page still picks up a later navigation to a
    // repository. `sync` ignores unknown URLs and repeat visits, so it is safe
    // to call on every location change.
    ctx.addEventListener(window, "wxt:locationchange", ({ newUrl }) => {
      void controller.sync(newUrl.toString());
    });

    await controller.sync(location.href);
  },
});

/**
 * Builds the badge for `repo`, or returns `null` when the attempt was superseded
 * by a newer navigation or the page never produced an anchor to attach to.
 */
async function mount(
  ctx: ContentScriptContext,
  repo: RepoRef,
  isStale: IsStale,
): Promise<ShadowRootContentScriptUi<Root> | null> {
  const anchor = await waitForAnchor(ctx, isStale);
  if (!anchor || ctx.isInvalid || isStale()) return null;

  const ui = await createShadowRootUi<Root>(ctx, {
    name: "github-star-rag-badge",
    position: "inline",
    anchor,
    append: "after",
    onMount(container) {
      const root = createRoot(container);
      root.render(<EndorsementBadge owner={repo.owner} name={repo.name} />);
      return root;
    },
    onRemove(root) {
      root?.unmount();
    },
  });

  // The stylesheet fetch above is another await, so the navigation may have
  // happened while it was in flight.
  if (isStale()) {
    ui.remove();
    return null;
  }

  ui.mount();
  return ui;
}

/**
 * The repository header is rendered after the initial HTML and its class names
 * are hashed, so the anchor is found through stable `data-` attributes with a
 * bounded retry rather than a brittle class selector.
 */
async function waitForAnchor(ctx: ContentScriptContext, isStale: IsStale): Promise<Element | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const anchor = findAnchor();
    if (anchor) return anchor;
    if (ctx.isInvalid || isStale()) return null;
    await new Promise<void>((resolve) => {
      ctx.setTimeout(() => resolve(), 250);
    });
  }
  return null;
}

function findAnchor(): Element | null {
  return (
    document.querySelector("[data-testid='repository-container-header']") ??
    document.querySelector("#repository-container-header") ??
    document.querySelector("main")
  );
}
