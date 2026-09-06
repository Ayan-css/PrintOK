const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function runAgentProtocolTest() {
  console.log('[Print Agent Protocol Test] Starting E2E validation...');

  const baseUrl = 'http://localhost:4000';

  // 1. Register Shop & Printer
  const regRes = await fetch(`${baseUrl}/api/shops/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shopName: 'Speedy Print Shop',
      ownerEmail: 'owner@speedyprint.com',
      printerName: 'HP LaserJet Pro M404dn',
    }),
  });
  const regData = await regRes.json();
  console.log(`[Shop Registered] Shop ID: ${regData.shop.id}, Printer ID: ${regData.printer.id}`);
  console.log(`[QR Code Data URI Generated] Length: ${regData.printer.qrCodeDataUrl.length} chars`);

  const apiKey = regData.printer.apiKey;
  const printerId = regData.printer.id;

  // 2. Customer Uploads Print Job
  const pdfContent = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
  const pdfBase64 = Buffer.from(pdfContent).toString('base64');
  const expectedChecksum = crypto.createHash('sha256').update(pdfBase64).digest('hex');

  const jobRes = await fetch(`${baseUrl}/api/print-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      printerId,
      fileName: 'invoice_1092.pdf',
      fileBase64: pdfBase64,
      pageCount: 2,
      copies: 1,
      isColor: false,
    }),
  });
  const jobData = await jobRes.json();
  const jobId = jobData.job.id;
  console.log(`[Print Job Created] Job ID: ${jobId}, State: ${jobData.job.printState}`);

  // 3. Agent Polls Pending Jobs
  const pollRes = await fetch(`${baseUrl}/api/agent/jobs/pending`, {
    headers: { 'x-agent-api-key': apiKey },
  });
  const pollData = await pollRes.json();
  console.log(`[Agent Polled] Received ${pollData.jobs.length} pending job(s)`);

  if (pollData.jobs.length !== 1 || pollData.jobs[0].id !== jobId) {
    throw new Error('Agent failed to receive expected job');
  }

  const job = pollData.jobs[0];

  // 4. Agent Validates Checksum & Simulates Printing
  const base64Data = job.fileUrl.replace('data:application/pdf;base64,', '');
  const computedChecksum = crypto.createHash('sha256').update(base64Data).digest('hex');

  if (computedChecksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch! Expected: ${expectedChecksum}, Computed: ${computedChecksum}`);
  }
  console.log(`[Checksum Verified] SHA-256: ${computedChecksum}`);

  // Save to temporary file & immediately clean up
  const tempPath = path.join('/tmp', `printok_${jobId}_${job.fileName}`);
  fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
  console.log(`[Temp File Written] Path: ${tempPath}`);

  // Update Status: Printing
  await fetch(`${baseUrl}/api/agent/jobs/${jobId}/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-api-key': apiKey,
    },
    body: JSON.stringify({ jobId, printState: 'Printing' }),
  });
  console.log(`[Status Updated] Printing`);

  // Simulate hardware print delay
  await new Promise((r) => setTimeout(r, 200));

  // Immediate Privacy Cleanup
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
    console.log(`[Temp File Cleaned Up] Deleted ${tempPath}`);
  }

  // Update Status: Completed
  const finalRes = await fetch(`${baseUrl}/api/agent/jobs/${jobId}/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-api-key': apiKey,
    },
    body: JSON.stringify({ jobId, printState: 'Completed' }),
  });
  const finalData = await finalRes.json();
  console.log(`[Status Updated] Final State: ${finalData.job.printState}`);

  if (finalData.job.printState !== 'Completed') {
    throw new Error(`Job state is not Completed: ${finalData.job.printState}`);
  }

  console.log('[Print Agent Protocol Test] SUCCESS! All checks passed.\n');
}

runAgentProtocolTest().catch((err) => {
  console.error('[Print Agent Protocol Test] FAILED:', err);
  process.exit(1);
});
