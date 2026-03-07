#!/usr/bin/env node

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const YOUR_EMAIL = process.argv[2] || 'your-email@example.com';

async function main() {
  console.log(`Sending test invoice email to: ${YOUR_EMAIL}`);
  
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || process.env.RESEND_FROM || 'billing@yourpractice.com',
      to: [YOUR_EMAIL],
      subject: 'Invoice INV-TEST - ${process.env.PRACTICE_NAME || "Your Practice"}',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f7931a, #fbb040); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
            <div style="font-size: 48px; margin-bottom: 10px;">₿</div>
            <h1 style="color: white; margin: 0; font-size: 24px;">${process.env.PRACTICE_NAME || "Your Practice"}</h1>
          </div>
          
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="font-size: 16px; color: #111827; margin-bottom: 20px;">
              Hi there,
            </p>
            
            <p style="font-size: 16px; color: #111827; margin-bottom: 30px;">
              Your monthly Direct Primary Care invoice is ready. This is a test email.
            </p>
            
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Invoice Number:</td>
                  <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">INV-TEST</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Amount Due:</td>
                  <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">$150.00</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Due Date:</td>
                  <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">February 28, 2026</td>
                </tr>
              </table>
            </div>
            
            <div style="text-align: center; margin-bottom: 30px;">
              <a href="${process.env.BILLING_URL || "https://billing.example.com"}/pay/test123" style="display: inline-block; background: #f7931a; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                Pay Invoice
              </a>
            </div>
            
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px; border-radius: 4px; margin-bottom: 20px;">
              <p style="margin: 0; font-size: 14px; color: #92400e;">
                <strong>Payment Options:</strong> We accept Bitcoin (on-chain), Lightning, ACH, and credit cards.
              </p>
            </div>
            
            <p style="font-size: 14px; color: #6b7280; line-height: 1.6;">
              If you have any questions about this invoice, please don't hesitate to contact us.
            </p>
            
            <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
              Thank you,<br>
              <strong style="color: #111827;">${process.env.PRACTICE_NAME || "Your Practice"}</strong>
            </p>
          </div>
          
          <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
            <p style="margin: 0;">${process.env.PRACTICE_NAME || "Your Practice"}</p>
            <p style="margin: 5px 0 0 0;">Secure, private healthcare powered by Bitcoin and Nostr</p>
          </div>
        </div>
      `,
    });
    
    console.log('✓ Test email sent successfully!');
    console.log('Check your inbox (and spam folder)');
    
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

main();
