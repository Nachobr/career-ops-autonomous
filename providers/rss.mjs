// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// RSS / Atom feed provider — parses XML feeds using regex.
// Supports both RSS (<item>) and Atom (<entry>) schemas.

function cleanText(str) {
  if (!str) return '';
  // Strip CDATA wrapper
  str = str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Strip simple HTML tags if title has them
  str = str.replace(/<\/?[a-z][^>]*>/gi, '');
  // Decode basic XML/HTML entities
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

/** @type {Provider} */
export default {
  id: 'rss',

  detect(entry) {
    if (entry.provider === 'rss' && entry.rss) {
      return { url: entry.rss };
    }
    if (entry.rss) {
      return { url: entry.rss };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const url = entry.rss || entry.careers_url;
    if (!url) throw new Error(`rss: missing feed URL for ${entry.name}`);

    const xml = await ctx.fetchText(url);
    const jobs = [];

    // Detect if RSS (<item>) or Atom (<entry>)
    const hasItems = xml.includes('<item>');
    const entries = hasItems
      ? xml.match(/<item>[\s\S]*?<\/item>/gi) || []
      : xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];

    for (const itemXml of entries) {
      // Title
      const titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? cleanText(titleMatch[1]) : '';

      // Link (handle <link>text</link> and <link href="..." />)
      let link = '';
      const linkTagMatch = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      if (linkTagMatch && linkTagMatch[1].trim()) {
        link = cleanText(linkTagMatch[1]);
      } else {
        const hrefMatch = itemXml.match(/<link\s+[^>]*href=["']([^"']+)["']/i);
        if (hrefMatch) link = cleanText(hrefMatch[1]);
      }

      // Location - standard namespaces (like <location> or <georss:point>)
      let location = '';
      const locMatch = itemXml.match(/<(?:[a-z]+:)?location[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?location>/i);
      if (locMatch) {
        location = cleanText(locMatch[1]);
      } else {
        // Try other common tags like category/subcategory if it indicates remote/country
        const catMatches = itemXml.match(/<(?:[a-z]+:)?category[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?category>/gi) || [];
        const cats = catMatches.map(c => {
          const m = c.match(/<(?:[a-z]+:)?category[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?category>/i);
          return m ? cleanText(m[1]) : '';
        }).filter(Boolean);
        if (cats.length > 0) {
          location = cats.join(', ');
        }
      }

      if (title && link) {
        jobs.push({
          title,
          url: link,
          company: entry.name,
          location,
        });
      }
    }

    return jobs;
  },
};
