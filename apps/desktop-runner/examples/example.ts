import { workflow } from "libretto";

export default workflow("example-page-title", {
  startUrl: "https://example.com",
  handler: async ({ page }) => {
    const title = await page.title();
    console.log(`Page title: ${title}`);
    return { title };
  },
});
