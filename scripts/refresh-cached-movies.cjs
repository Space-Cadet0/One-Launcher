const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const cachePath = path.join(__dirname, '../src/services/storage/steamEnrichedCache.json');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

  const appIds = Object.keys(cache).filter((appId) => {
    const data = cache[appId];
    return data.movies && data.movies.length > 0 && !data.movies.some((m) => m.hls || m.hls_h264);
  });

  console.log(`Found ${appIds.length} games needing movie stream updates.`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < appIds.length; i++) {
    const appId = appIds[i];
    const gameName = cache[appId].name;

    try {
      const res = await axios.get(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=movies&l=english`,
        { timeout: 6000 }
      );

      const rawMovies = res.data?.[appId]?.data?.movies;
      if (rawMovies && rawMovies.length > 0) {
        cache[appId].movies = rawMovies.map((m) => {
          const hls = m.hls_h264 || '';
          const dashH264 = m.dash_h264 || '';
          const dashAv1 = m.dash_av1 || '';
          const mp4Max = m.mp4?.max && !m.mp4.max.includes('.mpd') && !m.mp4.max.includes('.m3u8') ? m.mp4.max : '';
          const mp4Low = m.mp4?.['480'] && !m.mp4['480'].includes('.mpd') && !m.mp4['480'].includes('.m3u8') ? m.mp4['480'] : '';

          return {
            id: m.id,
            name: m.name,
            thumbnail: m.thumbnail,
            hls,
            hls_h264: hls,
            dash_h264: dashH264,
            dash_av1: dashAv1,
            webm: m.webm || {},
            mp4: {
              ...(m.mp4 || {}),
              ...(mp4Low ? { '480': mp4Low } : {}),
              ...(mp4Max ? { max: mp4Max } : {}),
            },
            highlight: m.highlight,
          };
        });
        successCount++;
        console.log(`[${i + 1}/${appIds.length}] Updated ${appId} (${gameName}): ${cache[appId].movies.length} movies`);
      } else {
        console.log(`[${i + 1}/${appIds.length}] No movies returned for ${appId} (${gameName})`);
      }
    } catch (err) {
      failCount++;
      console.warn(`[${i + 1}/${appIds.length}] Failed for ${appId} (${gameName}): ${err.message}`);
    }

    // Rate-limit throttle to avoid Steam 429
    await sleep(250);
  }

  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`Finished updating movies! Successfully updated: ${successCount}, Failed: ${failCount}`);
}

main().catch(console.error);
