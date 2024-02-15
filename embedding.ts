require("dotenv").config();
import { Tiktoken } from "@dqbd/tiktoken";
import { neon } from "@neondatabase/serverless";
import fs from "fs/promises";
import OpenAI from "openai";
import path from "path";
const cl100k_base = require("tiktoken/encoders/cl100k_base.json");

const databaseUrl = process.env.DATABASE_URL;
const openAi_key = process.env.OPENAI_KEY;

if (!databaseUrl || !openAi_key) {
  throw new Error("DATABASE_URL must be set");
}

// Instantiation de l'API OPENAI
const openai = new OpenAI({
  apiKey: openAi_key,
});

// Instantiation de la base de données NEON
const sql = neon(databaseUrl);

const encoding = new Tiktoken(
  cl100k_base.bpe_ranks,
  cl100k_base.special_tokens,
  cl100k_base.pat_str
);

//------------------------------------------------------------------------------------------------
//--------------------------------------- STEP 1---------------------------------------------------
//------------------------------------------------------------------------------------------------

type TextFile = {
  filePath: string;
  text: string;
  token?: Uint32Array; // Add a token property to the TextFile type
};

/**
 * Processes the files in a given folder and returns an array of TextFile objects.
 * @param folder The folder path where the files are located.
 * @returns A promise that resolves to an array of TextFile objects.
 */
async function processFiles(folder: string): Promise<TextFile[]> {
  const files: TextFile[] = [];

  const folderPath = `./data/${folder}`;
  const entries = await fs.readdir(folderPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullpath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      continue;
    }
    const text = await fs.readFile(fullpath, "utf-8");

    files.push({
      filePath: entry.name,
      text,
    });
  }

  return files;
}

//------------------------------------------------------------------------------------------------
//--------------------------------------- STEP 2---------------------------------------------------
//------------------------------------------------------------------------------------------------
type TextFileToken = TextFile & {
  token: Uint32Array;
};

/**
 * Tokenizes the text content of multiple files.
 * @param files The array of TextFile objects to tokenize.
 * @returns A promise that resolves to an array of TextFileToken objects.
 */
const tiktokenizer = async (files: TextFile[]): Promise<TextFileToken[]> => {
  const textFileTokens: TextFileToken[] = [];

  for (const file of files) {
    const token = encoding.encode(file.text);
    textFileTokens.push({ ...file, token });
  }

  return textFileTokens;
};
//------------------------------------------------------------------------------------------------
//--------------------------------------- STEP 3---------------------------------------------------
//------------------------------------------------------------------------------------------------

const MAX_TOKENS = 500;
/**
 * Splits a text file into multiple chunks based on the maximum number of tokens.
 * @param text The text file to be split.
 * @returns An array of text files, each containing a chunk of the original text.
 */
async function splitTextToMany(text: TextFileToken): Promise<TextFile[]> {
  const sentences = text.text
    .split(". ")
    .map((sentence) => ({
      text: sentence,
      numberTokens: encoding.encode(sentence).length,
    }))
    .reduce((acc, sentence) => {
      // if sentence is too long split by \n
      if (sentence.numberTokens > MAX_TOKENS) {
        const sentences = sentence.text.split("\n").map((sentence) => ({
          text: sentence,
          numberTokens: encoding.encode(sentence).length,
        }));

        return [...acc, ...sentences];
      }
      return [...acc, sentence];
    }, [] as { text: string; numberTokens: number }[]);

  // Split the text into chunks of at most MAX_TOKENS tokens
  // What does chunks mean?
  const chunks: TextFile[] = [];

  let tokensSoFar = 0;
  let currentChunks: TextFileToken[] = [];

  for (const sentence of sentences) {
    const numberToken = sentence.numberTokens; // Convert Uint32Array to number

    if (tokensSoFar + numberToken > MAX_TOKENS) {
      currentChunks.push({
        filePath: text.filePath,
        text: sentence.text,
        token: new Uint32Array(),
      });
      const chunkText = currentChunks.map((c) => c.text).join(". ");
      chunks.push({
        filePath: text.filePath,
        text: currentChunks.map((c) => c.text).join(". "),
        token: encoding.encode(chunkText),
      });
      currentChunks = []; // Reset the currentChunks array to empty the array
      tokensSoFar = 0; // Reset the tokensSoFar to 0 to start counting again
    }
    currentChunks.push({
      filePath: text.filePath,
      text: sentence.text,
      token: new Uint32Array(),
    });

    tokensSoFar += numberToken;
  }

  if (currentChunks.length > 0) {
    const chunkText = currentChunks.map((c) => c.text).join(". ");
    chunks.push({
      filePath: text.filePath,
      text: currentChunks.map((c) => c.text).join(". "),
      token: encoding.encode(chunkText),
    });
  }

  return chunks;
}

/**
 * Splits an array of TextFileToken objects into an array of TextFile objects.
 * If a TextFileToken's token length exceeds MAX_TOKENS, it is split into multiple TextFile objects.
 * @param texts - The array of TextFileToken objects to be split.
 * @returns A Promise that resolves to an array of TextFile objects.
 */
async function splitText(texts: TextFileToken[]): Promise<TextFile[]> {
  const shortened: TextFile[] = [];
  for (const file of texts) {
    if (file.token.length > MAX_TOKENS) {
      const chunks = await splitTextToMany(file);
      // console.log("File content", file.text);
      // console.log("Chunks", chunks);
      shortened.push(...chunks);
    } else {
      shortened.push(file);
    }
  }
  return shortened;
}
//------------------------------------------------------------------------------------------------
//--------------------------------------- STEP 4---------------------------------------------------
//------------------------------------------------------------------------------------------------
type textFileTokenEmbeding = TextFileToken & {
  embedding: number[];
};

async function processEmbeddings(
  texts: TextFileToken[]
): Promise<textFileTokenEmbeding[]> {
  const embededs: textFileTokenEmbeding[] = [];
  let i = 0;

  for await (const file of texts) {
    const result = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: file.text,
      encoding_format: "float",
    });

    const embeddings = result.data[0].embedding;
    embededs.push({
      ...file,
      embedding: embeddings,
    });
    i++;
    console.log("Finished embedding", file.filePath, `${i}/${texts.length}`);
  }

  return embededs;
}
//------------------------------------------------------------------------------------------------
//--------------------------------------- STEP 5---------------------------------------------------
//------------------------------------------------------------------------------------------------
/**
 * Saves the given texts to the database.
 * @param texts An array of objects containing the text, embedding, filePath, and token information.
 * @returns A Promise that resolves when all texts have been saved to the database.
 */
async function saveToDatabase(texts: textFileTokenEmbeding[]) {
  let totalSaved = 0;
  let totalSkipped = 0;
  for await (const row of texts) {
    let { embedding, filePath, text, token } = row;
    totalSaved++;

    if (text.length < 100) {
      totalSkipped++;
      console.log("🚫 Skipping: ", text, `Total :  ${totalSkipped}`);
      continue;
    }

    const vectorSize = 1536;
    const verctorPadded = new Array(vectorSize).fill(0); // Create an array of 1536 elements filled with 0
    verctorPadded.splice(0, embedding.length, ...embedding); // Replace the first 1536 elements with the embeddings

    const insertQuery = `INSERT INTO documents (text, n_tokens, file_path, embeddings) VALUES ($1, $2, $3, $4);`;

    const tokens = encoding.encode(text);
    const tokensLength = tokens.length;

    console.log({
      tokensLength,
    });
    await sql(insertQuery, [
      text,
      tokensLength,
      filePath,
      JSON.stringify(verctorPadded),
    ]);
    console.log(
      "🎈 Saved to database: ",
      filePath,
      `${totalSaved}/${texts.length}`
    );
  }
}
//------------------------------------------------------------------------------------------------
//--------------------------------------- MAIN ---------------------------------------------------
//------------------------------------------------------------------------------------------------

// Function principale
async function main() {
  const FOLDER = "gama";

  const texts = await cache_withFile(
    () => processFiles(FOLDER),
    "processed/texts.json"
  );
  //--------------------------------------- STEP 2 CALLING ---------------------------------------------------
  const textTokens = await cache_withFile(
    () => tiktokenizer(texts),
    "processed/textTokens.json"
  );
  console.log("TextTokens", textTokens.length);
  //--------------------------------------- STEP 3 CALLING---------------------------------------------------
  const shortenedTexts = await cache_withFile(
    () => splitText(textTokens),
    "processed/shortenedTexts.json"
  );
  console.log("ShortenedTexts", shortenedTexts.length);
  //--------------------------------------- STEP 4 CALLING---------------------------------------------------
  const embeddings = await cache_withFile(
    () => processEmbeddings(shortenedTexts),
    "processed/textTokensEmbeddings.json"
  );

  //--------------------------------------- STEP 5 CALLING---------------------------------------------------
  await saveToDatabase(embeddings);
  //1 - Recuperer tous les textes avec leurs urls✅
  //2 - Tokenizer tous les textes ✅
  //3 - Shorten tous les textes selon une limitation precise pour pas qu'ils soient trop longs ✅
  //4 - Embed tous les textes
  //5 - Sauvegarder les embeddings dans la base de données
}

/**
 * Caches the result of a function in a file and returns the cached data if available.
 * If the cache file does not exist or is invalid, the function is executed and the result is cached.
 * @param func The function to be executed and cached.
 * @param filePath The path to the cache file.
 * @returns The cached data if available, otherwise the result of executing the function.
 */
async function cache_withFile<T>(func: () => Promise<T>, filePath: string) {
  console.log("Running function", func.toString());
  console.log("Cache", filePath);
  try {
    await fs.access(filePath);
    const fileData = await fs.readFile(filePath, "utf-8");

    console.log("🦺 Using cache file");
    return JSON.parse(fileData);
  } catch (error) {
    const data = await func();

    console.log("📦 Writing cache file");

    await fs.writeFile(filePath, JSON.stringify(data));

    return data;
  }
}

main();
