/** the `serviceName` each utility process this app forks carries; Electron reports it as the `name` of its child-process-gone */
export const UTILITY_NAMES = Object.freeze({ server: "Metal server", devServer: "Metal dev server", companion: "Metal companion" });

const OWN = new Set(Object.values(UTILITY_NAMES));

/** a child-process-gone for one of our own utility processes: the code that forked it knows whether it was stopped on purpose */
export const ownUtility = (details) => details?.type === "Utility" && OWN.has(details?.name);
