if (!nav) {
  throw new Error("nav element not found");
}
// get the `ul` element
const links = await nav.$$("a");

console.log("Type of :", typeof links);
console.log("Found links:", links.length);
// get all links
const urls = await Promise.all(
  links.map(async (link) => {
    const href = await link.getAttribute("href");
    return href;
  })
);
// Can you update the urls element according to the following html code?
// console.log("Found links:", urls);
// navigate to each link
for (const url of urls) {
  // console.log("Visiting url:", url);
  await page.goto(` https://gama-platform.org${url}`);

  // get the content of the div with class .prose.prose-vercel
  const content = await page.$eval(
    "div.theme-doc-markdown.markdown",
    (el) => el.textContent
  );
  if (!content) {
    continue;
  }

  const encodeUrlForFileName = `https://gama-platform.org/${url}`.replace(
    /\//g,
    "-"
  );

  //write the fetched content to a file
  const pathfile = `./data/nextjs/${encodeUrlForFileName}.txt`;
  console.log("Writing to file:", pathfile);

  fs.writeFile(pathfile, content);
}
