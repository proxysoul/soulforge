import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const bedrock: ProviderDefinition = {
  id: "bedrock",
  name: "Bedrock",
  envVar: "AWS_ACCESS_KEY_ID",
  icon: "\uF0AC", // nf-fa-globe U+F0AC
  secretKey: "aws-access-key-id",
  asciiIcon: "B",
  description: "Amazon Bedrock",

  createModel(modelId: string) {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
    }
    return createAmazonBedrock({ region, accessKeyId, secretAccessKey, sessionToken })(modelId);
  },

  async checkAvailability(): Promise<boolean> {
    return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    // Bedrock doesn't expose a simple models listing endpoint
    return null;
  },

  fallbackModels: [
    { id: "anthropic.claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" },
    { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" },
    { id: "us.amazon.nova-pro-v1:0", name: "Amazon Nova Pro" },
    { id: "us.amazon.nova-lite-v1:0", name: "Amazon Nova Lite" },
    { id: "meta.llama3-1-70b-instruct-v1:0", name: "Llama 3.1 70B" },
  ],

  contextWindows: [
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-haiku-4", 200_000],
    ["claude-3-5-sonnet", 200_000],
    ["claude-3-opus", 200_000],
    ["claude-3-haiku", 200_000],
    ["nova-premier", 1_000_000],
    ["nova-pro", 300_000],
    ["nova-lite", 300_000],
    ["nova-micro", 128_000],
    ["llama3-1-405b", 128_000],
    ["llama3-1-70b", 128_000],
    ["llama3-1-8b", 128_000],
    ["mistral-large", 128_000],
  ],
};
