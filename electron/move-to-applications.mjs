// macOS: a copy opened from the mounted disk image (or Downloads) offers to move itself into Applications first. run from
// the disk image it cannot update itself, and it stops when the image is ejected.

const node = (name) => globalThis.process.getBuiltinModule(name);

export function bundleOf(execPath) {
  const path = node("node:path");
  const app = path.resolve(execPath, "..", "..", "..");
  return app.endsWith(".app") ? app : null;
}

export function inApplications(bundle, home) {
  if (!bundle) return false;
  const path = node("node:path");
  return [path.join("/", "Applications"), path.join(home, "Applications")].some((dir) => bundle.startsWith(`${dir}${path.sep}`));
}

export function shouldOfferMove({ platform, packaged, bundle, home, isInApplicationsFolder, automated = false, atLogin = false, declined = false, fromDiskImage = false }) {
  if (platform !== "darwin" || !packaged || automated || atLogin || !bundle) return false;
  if (inApplications(bundle, home)) return false;
  try { if (isInApplicationsFolder()) return false; } catch {}
  return fromDiskImage || !declined;
}

export function moveDialog({ fromDiskImage }) {
  return {
    type: "question",
    message: "Move Metal to Applications?",
    detail: fromDiskImage
      ? "Metal is running from the disk image. Move it to Applications to keep it after you eject."
      : "Move Metal to the Applications folder for easier access.",
    buttons: ["Move to Applications", "Not now"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    ...(fromDiskImage ? {} : { checkboxLabel: "Don't ask again" }),
  };
}

/**
 * electron's moveToApplicationsFolder replaces an older copy already there (a running one is focused instead), then quits
 * and opens the moved copy. true when the app is about to relaunch.
 */
export async function offerMoveToApplications({ app, ask, memory, home, execPath, platform = process.platform, automated = false, atLogin = false, log = () => {} }) {
  const bundle = bundleOf(execPath);
  const fromDiskImage = Boolean(bundle?.startsWith("/Volumes/"));
  let declined = false;
  try { declined = memory.read()?.declined === true; } catch {}
  if (!shouldOfferMove({ platform, packaged: app.isPackaged, bundle, home, isInApplicationsFolder: () => app.isInApplicationsFolder(), automated, atLogin, declined, fromDiskImage })) return false;
  const { response, checkboxChecked } = await ask(moveDialog({ fromDiskImage }));
  if (response !== 0) {
    if (checkboxChecked) { try { memory.write({ declined: true }); } catch {} }
    log(`move to applications: not now${checkboxChecked ? ", not asked again" : ""}`);
    return false;
  }
  try {
    const moved = app.moveToApplicationsFolder();
    log(`move to applications: ${moved ? "moved, relaunching" : "not moved"}`);
    return moved;
  } catch (error) {
    log(`move to applications failed: ${error?.message ?? error}`);
    return false;
  }
}
