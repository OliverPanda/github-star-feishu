import { describe, expect, it, vi } from "vitest";
import { createBadgeController, type BadgeHandle } from "../lib/badge-controller.js";
import { createLatestOnly, type IsStale } from "../lib/latest-only.js";
import type { RepoRef } from "../lib/github.js";

const REPO_A = "https://github.com/karpathy/nanoGPT";
const REPO_B = "https://github.com/rust-lang/cargo";

/** A factory whose builds block until the test resolves them, one by one. */
function deferredFactory() {
  const pending: {
    repo: RepoRef;
    isStale: IsStale;
    handle: BadgeHandle & { remove: ReturnType<typeof vi.fn> };
    resolve(): void;
  }[] = [];

  const create = vi.fn((repo: RepoRef, isStale: IsStale) => {
    return new Promise<BadgeHandle | null>((resolve) => {
      const handle = { remove: vi.fn() };
      pending.push({ repo, isStale, handle, resolve: () => resolve(handle) });
    });
  });

  return {
    create,
    get count(): number {
      return pending.length;
    },
    /** Resolves build `index`; the controller then applies its staleness check. */
    async finish(index: number): Promise<BadgeHandle> {
      const entry = pending[index]!;
      entry.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return entry.handle;
    },
    at: (index: number) => pending[index]!,
  };
}

describe("createLatestOnly", () => {
  it("supersedes earlier generations", () => {
    const latest = createLatestOnly();
    const first = latest.begin();
    expect(first()).toBe(false);

    const second = latest.begin();
    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });
});

describe("createBadgeController", () => {
  it("mounts a badge for a repository page", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    const sync = controller.sync(REPO_A);
    // Nothing is on screen until the build finishes.
    expect(controller.currentRepo()).toBeNull();

    const handle = await factory.finish(0);
    await sync;

    expect(handle.remove).not.toHaveBeenCalled();
    expect(controller.currentRepo()).toBe("karpathy/nanoGPT");
  });

  it("does not build anything on a non-repository page", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    await controller.sync("https://github.com/karpathy");
    await controller.sync("https://github.com/settings/profile");
    await controller.sync("https://example.com/karpathy/nanoGPT");

    expect(factory.create).not.toHaveBeenCalled();
    expect(controller.currentRepo()).toBeNull();
  });

  it("rebuilds when navigating to a different repository", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    const first = controller.sync(REPO_A);
    const firstHandle = await factory.finish(0);
    await first;

    const second = controller.sync(REPO_B);
    const secondHandle = await factory.finish(1);
    await second;

    expect(firstHandle.remove).toHaveBeenCalledTimes(1);
    expect(secondHandle.remove).not.toHaveBeenCalled();
    expect(controller.currentRepo()).toBe("rust-lang/cargo");
  });

  it("ignores a repeat navigation to the repository already on screen", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    const navigation = controller.sync(REPO_A);
    await factory.finish(0);
    await navigation;

    await controller.sync(REPO_A);
    await controller.sync("https://github.com/karpathy/nanoGPT/tree/master");

    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it("keeps only the newest badge when a slow build is overtaken", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    // Repo B is navigated to while repo A's build is still awaiting its anchor.
    const staleNavigation = controller.sync(REPO_A);
    const freshNavigation = controller.sync(REPO_B);
    expect(factory.count).toBe(2);

    // The overtaken build finishes last: its badge must tear itself down rather
    // than stack on top of the current one.
    const staleHandle = await factory.finish(0);
    await staleNavigation;
    expect(staleHandle.remove).toHaveBeenCalledTimes(1);

    const freshHandle = await factory.finish(1);
    await freshNavigation;
    expect(freshHandle.remove).not.toHaveBeenCalled();
    expect(controller.currentRepo()).toBe("rust-lang/cargo");
  });

  it("cancels an in-flight build when navigation leaves the repository", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    const navigation = controller.sync(REPO_A);
    await controller.sync("https://github.com/karpathy");

    const handle = await factory.finish(0);
    await navigation;

    expect(handle.remove).toHaveBeenCalledTimes(1);
    expect(controller.currentRepo()).toBeNull();
  });

  it("removes the mounted badge on dispose", async () => {
    const factory = deferredFactory();
    const controller = createBadgeController(factory.create);

    const navigation = controller.sync(REPO_A);
    const handle = await factory.finish(0);
    await navigation;

    controller.dispose();
    expect(handle.remove).toHaveBeenCalledTimes(1);
    expect(controller.currentRepo()).toBeNull();
  });

  it("reports no repository on screen when the build found no anchor", async () => {
    const create = vi.fn(async () => null);
    const controller = createBadgeController(create);

    await controller.sync(REPO_A);

    expect(create).toHaveBeenCalledTimes(1);
    expect(controller.currentRepo()).toBeNull();
  });

  it("retries a repository whose first build found no anchor", async () => {
    const create = vi.fn(async () => null);
    const controller = createBadgeController(create);

    await controller.sync(REPO_A);
    await controller.sync(REPO_A);

    expect(create).toHaveBeenCalledTimes(2);
  });
});
