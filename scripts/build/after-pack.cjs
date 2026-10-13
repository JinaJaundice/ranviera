// electron-builder afterPack step: sets the Electron fuses of the packed app, so that the app cannot be run as plain
// Node, ignores NODE_OPTIONS and the inspector flags, checks the integrity of app.asar and loads code only from it.
const path = require("node:path");

exports.default = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import("@electron/fuses");
  const { appOutDir, electronPlatformName, packager } = context;
  const name = packager.appInfo.productFilename;
  const target =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${name}.app`)
      : electronPlatformName === "win32"
        ? path.join(appOutDir, `${name}.exe`)
        : path.join(appOutDir, packager.executableName);
  await flipFuses(target, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === "darwin",
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    // the app loads only its own http origin, so file: pages need no extra privileges
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  console.log(`Set the Electron fuses of ${path.basename(target)}.`);
};
