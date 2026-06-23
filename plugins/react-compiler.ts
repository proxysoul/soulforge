import { plugin } from "bun";

plugin({
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: /src\/.*\.tsx?$/ }, async ({ path, loader }) => {
      const { transformSync } = await import("@babel/core");
      const source = await Bun.file(path).text();
      const result = transformSync(source, {
        filename: path,
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        parserOpts: {
          plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
        },
      });
      return { contents: result?.code ?? source, loader };
    });
  },
});
