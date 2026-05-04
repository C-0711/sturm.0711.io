import { uploadFile, getFileSignedUrl, callMistralOcr, configToApiRequest } from "./src/lib/mistral-ocr/index.ts";
const apiKey = process.env.MISTRAL_API_KEY;
const filePath = "/home/christoph.bertsch/0711/0711-STURM/workspaces/einkommensteuererklaerung/einkommensteuererklaerung/ffcecb31-8b7a-4e8e-b579-e373bffdf314.pdf";
const { file_id } = await uploadFile(filePath, "Stricker.pdf", { apiKey });
const { url } = await getFileSignedUrl(file_id, { apiKey });
const req = configToApiRequest(
  { model: "mistral-ocr-latest", confidenceScoresGranularity: "word", pages: [0] },
  { type: "document_url", document_url: url, document_name: "Stricker.pdf" },
  { runId: "probe", stageId: "bbox" }
);
const resp = await callMistralOcr(req, { apiKey });
console.log("response keys:", Object.keys(resp));
console.log("pages count:", resp.pages?.length);
const p = resp.pages?.[0];
if (p) {
  console.log("pages[0] keys:", Object.keys(p));
  console.log("dimensions:", p.dimensions);
  const cs = p.confidence_scores;
  if (cs) {
    console.log("confidence_scores keys:", Object.keys(cs));
    if (cs.word_confidence_scores) {
      console.log("first 3 word entries:");
      console.log(JSON.stringify(cs.word_confidence_scores.slice(0,3), null, 2));
    }
  }
  console.log("images count:", p.images?.length ?? 0);
}
