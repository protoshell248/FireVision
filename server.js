import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';
import * as async from 'async';

const PORT = process.env.PORT || 8000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const screenshotMimeType = 'image/png';
const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/;

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
}

let currentStatus = null;
let isCancelled = false;
let browser = null;

app.post('/extract', async (req, res) => {
  let { apiKey, url, ocrModelName = "gemini-1.5-flash-8b", parallelism = 3, question = null, questionAnsweringModelName = "gemini-1.5-pro" } = req.body; // Default to 5 parallel requests if not specified

  apiKey = "AIzaSyDz3uayngYEPImdFPJOV7ZftGTtswaj4bs";

  if (!url) {
    res.status(400).send({ error: 'URL is required' });
    return;
  }

  isCancelled = false;

  try {
    currentStatus = "Beginning to generate screenshots..";
    const screenshots = await takeScreenshots(url);

    if(!isCancelled) {
        currentStatus = "All screenshots gathered. Beginning to perform OCR on gathered screenshots..";

        let extractedText = '';
        const results = [];
        let totalDone = 0;

        const genAI = new GoogleGenerativeAI(apiKey);

        const ocrModel = getGeminiModel(genAI, ocrModelName, 4096);

        await new Promise((resolve, reject) => {
          async.eachOfLimit(
            screenshots,
            parallelism,
            async (screenshotPath, idx) => {
                if(!isCancelled) {
                    console.log("\n=====================");
                    console.log(`performing ocr for image: (${idx + 1}). ${screenshotPath}...`);
                    const text = await performOcr(ocrModel, screenshotPath);
                    totalDone++;
                    currentStatus = `OCR completed: ${totalDone} of ${screenshots.length}`
                    const content = extractCodeOrMarkdownBlock(text);
                    console.log(`done performing ocr for image: (${idx + 1}). ${screenshotPath} =>\n${content}`);

                    // Store the result in the results array at the correct index
                    results[idx] = content;
                } else {
                    currentStatus = "Cancelled"
                }

                fs.unlinkSync(screenshotPath);
            },
            (err) => {
                if (err) {
                    reject(err); // Reject the promise if any task fails
                } else {
                    currentStatus = "All OCR completed"
                    resolve(); // Resolve the promise once all tasks complete
                }
            }
          );
        });

        if(isCancelled) {
            for(const screenshot of screenshots) {
                try {
                  fs.unlinkSync(screenshot);
                } catch (err) {
                  // ignored
                }
            }
        }

        extractedText = results.join('\n');

        let returnText = extractedText;
        if(question) {
            currentStatus = `Now generating answer to question...`;
            const model = getGeminiModel(genAI, questionAnsweringModelName, 2048);
            returnText = await answerQuestion(model, question, extractedText)
        }

        currentStatus = "Completed."

        res.set('Content-Type', 'text/plain');
        res.send(returnText);
    } else {
        currentStatus = "Cancelled"
        res.set('Content-Type', 'text/plain');
        res.send(null);
    }
  } catch (err) {
    console.error(err);
    currentStatus = `Error: ${err}`;
    res.status(500).send({ error: 'An error occurred' });
  }
});

app.get('/status', (req, res) => {
  try {
    if (currentStatus) {
      res.status(200).send(currentStatus);
    } else {
      res.status(204).send('No status available');
    }
  } catch (error) {
    console.error('Error fetching status:', error);
    res.status(500).send('Error fetching status');
  }
});

app.get('/cancel', (req, res) => {
    isCancelled = true;
    res.status(200).send('Cancellation successful.');
});

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function getGeminiModel(genAI, modelName, maxTokens = 4096){
    const generationConfig = {
      "temperature": 1,
      "topP": 0.95,
      "topK": 40,
      "maxOutputTokens": 4096,
      "responseMimeType": "text/plain",
    };

    return genAI.getGenerativeModel({
      model: modelName,
      generationConfig: generationConfig
    });
}

function fileToGenerativePart(path, mimeType) {
    return {
      inlineData: {
        data: fs.readFileSync(path).toString('base64'),
        mimeType
      }
    };
}

async function performOcr(model, imagePath) {
  const filePart = fileToGenerativePart(imagePath, screenshotMimeType);

  const prompt = 'Extract main content part from this screenshot of a part of the full web page into Markdown format. In case main content part is not there, you extract all content. Ensure that the extracted content from the page is includs all elements, such as headers, footers, subtexts, images (with alt text if possible), tables, etc, if they are present.';
  const generatedContent = await model.generateContent([prompt, filePart]);
  return generatedContent.response.text();
}

async function answerQuestion(model, question, markdownFormattedText) {
    console.log(`fetching answer for question: ${question}`);

    const chat = model.startChat();
    let result = await chat.sendMessage(`Based on this markdown formatted extracted data form a web page, answer this user question:::${question}\n\nExtracted data:::\n\n${markdownFormattedText}`);

    return result.response.text();
}

function extractCodeOrMarkdownBlock(inputText) {
    const match = inputText.match(codeBlockRegex);

    if (match) {
        return match[1].trim();
    } else {
        return inputText;
    }
}

async function takeScreenshots(url) {
    try {
        if(!browser) {
            browser = await puppeteer.launch();   
        }

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0');

        const viewportHeight = 1200;
        const viewportWidth = 1020;
        await page.setViewport({ width: viewportWidth, height: viewportHeight, deviceScaleFactor: 2 });

        await page.goto(url, { waitUntil: 'networkidle2' });
        await sleep(1000);

        const pageHeight = await page.evaluate(() => document.body.scrollHeight);

        const screenshots = [];

        let totalScreenshots = Math.ceil(pageHeight / viewportHeight);
        const lastClipHeight = pageHeight - ((totalScreenshots - 1) * viewportHeight);

        // Check if the last screenshot is less than 1/4th of the viewport height
        if (lastClipHeight < viewportHeight / 4) {
            totalScreenshots -= 1; // Merge the last screenshot into the previous one
        }

        console.log(`Total Screenshots to be taken: ${totalScreenshots}`);
        currentStatus = `Total Screenshots to be taken: ${totalScreenshots}`;

        for (let index = 0; index < totalScreenshots; index++) {
            if(!isCancelled) {
                currentStatus = `Taking screenshot ${index + 1} of ${totalScreenshots}...`;

                const position = index * viewportHeight;

                await page.evaluate((scrollPos) => {
                    window.scrollTo(0, scrollPos);
                }, position);

                // Wait for the page to render after scrolling
                await sleep(1000);

                let clipHeight;

                // Adjust the height for the last screenshot if we've merged the last part
                if (index === totalScreenshots - 1 && lastClipHeight < viewportHeight / 4) {
                    clipHeight = pageHeight - position; // Extend the height to include the last part
                } else {
                    clipHeight = Math.min(viewportHeight, pageHeight - position);
                }

                // Take screenshot
                const screenshotPath = path.join(screenshotsDir, `screenshot_${index}.png`);
                await page.screenshot({
                    path: screenshotPath,
                    clip: {
                        x: 0,
                        y: position,
                        width: viewportWidth,
                        height: clipHeight,
                    },
                    type: 'png',
                    fullPage: false,
                });

                screenshots.push(screenshotPath);

                console.log(`Screenshot ${index + 1} saved to ${screenshotPath}`);
            }
        }

        return screenshots;
    } catch (error) {
        console.error('Error taking screenshots:', error);
        throw error;
    }
}

async function shutdown() {
    console.log('Shutting down the server...');
    if (browser) {
      await browser.close();
      console.log('Browser closed');
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
