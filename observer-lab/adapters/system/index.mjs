import { command, lines, observation } from "../../lib/core.mjs";

export const capabilities = ["BOOT_TIME", "BREW_SERVICES", "LOCALE", "OS_VERSION", "TIMEZONE"];

export async function capture({ phase, config }) {
  const startedAt = new Date().toISOString();
  const errors = [];
  const sw = await command("/usr/bin/sw_vers");
  const timezone = await command("/bin/ls", ["-l", "/etc/localtime"]);
  const locale = await command("/usr/bin/locale");
  const bootTime = await command("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
  const services = await command(config.brewPath ?? "/opt/homebrew/bin/brew", ["services", "list"]);
  for (const [name, result] of [["OS", sw], ["TIMEZONE", timezone], ["LOCALE", locale], ["BOOT_TIME", bootTime], ["SERVICES", services]]) {
    if (!result.ok) errors.push(`SYSTEM_${name}_UNAVAILABLE`);
  }
  return observation("system", phase, {
    os: sw.ok ? lines(sw.stdout) : [],
    timezone: timezone.ok ? timezone.stdout : null,
    locale: locale.ok ? lines(locale.stdout) : [],
    bootTime: bootTime.ok ? bootTime.stdout : null,
    brewServices: services.ok ? lines(services.stdout).slice(1) : [],
  }, errors, startedAt, new Date().toISOString(), capabilities);
}
