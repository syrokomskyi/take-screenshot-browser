import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER: DurableObjectNamespace;
  MYBROWSER: Fetcher;
  BUCKET: R2Bucket;
}

interface BrowserState {
  storage: DurableObjectStorage;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.BROWSER.idFromName("browser");
    const obj = env.BROWSER.get(id);
    const resp = await obj.fetch(request.url);
    return resp;
  },
};

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

export class Browser {
  private state: DurableObjectState;
  private env: Env;
  private keptAliveInSeconds: number;
  private storage: DurableObjectStorage;
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private browser: any;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.keptAliveInSeconds = 0;
    this.storage = this.state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    // screen resolutions to test out
    const width: number[] = [1920, 1366, 1536, 360, 414];
    const height: number[] = [1080, 768, 864, 640, 896];

    // use the current date and time to create a folder structure for R2
    const nowDate = new Date();
    const coeff = 1000 * 60 * 5;
    const roundedDate = new Date(
      Math.round(nowDate.getTime() / coeff) * coeff,
    ).toString();
    const folder = roundedDate.split(" GMT")[0];

    //if there's a browser session open, re-use it
    if (!this.browser || !this.browser.isConnected()) {
      console.log("Browser DO: Starting new instance");
      try {
        this.browser = await puppeteer.launch(this.env.MYBROWSER);
      } catch (e) {
        console.log(
          `Browser DO: Could not start browser instance. Error: ${e}`,
        );
      }
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0;

    const page = await this.browser.newPage();

    // take screenshots of each screen size
    for (let i = 0; i < width.length; i++) {
      await page.setViewport({ width: width[i], height: height[i] });
      await page.goto("https://workers.cloudflare.com/");
      const fileName = `screenshot_${width[i]}x${height[i]}`;
      const sc = await page.screenshot({ path: `${fileName}.jpg` });

      await this.env.BUCKET.put(`${folder}/${fileName}.jpg`, sc);
    }

    // Close tab when there is no more work to be done on the page
    await page.close();

    // Reset keptAlive after performing tasks to the DO.
    this.keptAliveInSeconds = 0;

    // set the first alarm to keep DO alive
    const currentAlarm = await this.storage.getAlarm();
    if (currentAlarm == null) {
      console.log("Browser DO: setting alarm");
      const TEN_SECONDS = 10 * 1000;
      await this.storage.setAlarm(Date.now() + TEN_SECONDS);
    }

    return new Response("success");
  }

  async alarm(): Promise<void> {
    this.keptAliveInSeconds += 10;

    // Extend browser DO life
    if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
      console.log(
        `Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`,
      );
      await this.storage.setAlarm(Date.now() + 10 * 1000);
      // You could ensure the ws connection is kept alive by requesting something
      // or just let it close automatically when there  is no work to be done
      // for example, `await this.browser.version()`
    } else {
      console.log(
        `Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`,
      );
      if (this.browser) {
        console.log("Closing browser.");
        await this.browser.close();
      }
    }
  }
}
