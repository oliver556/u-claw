export function createDesktopMainOptions() {
  return {
    spawn() {
      throw new Error("fixture spawn must not run");
    },
    buildGatewayLaunchOptions() {
      return {};
    },
    requiredMethods: ["gateway.get-status"],
    async probeCapabilities() {
      return { helloOk: false, methods: [] };
    },
    async dispatchClient() {
      return null;
    },
  };
}
