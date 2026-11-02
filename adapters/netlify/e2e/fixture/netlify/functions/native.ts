export default () =>
  Response.json({
    native: true,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  });

export const config = { path: "/native-check" };
