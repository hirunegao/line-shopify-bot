// 必要なライブラリを読み込む
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { Client } = require('@notionhq/client');
const OpenAI = require('openai');
const cron = require('node-cron');
require('dotenv').config();

// 各サービスの初期設定
const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LINE設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const lineClient = new line.Client(lineConfig);

// Shopify設定
const shopifyAxios = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

// 在庫チェック用の商品リスト（後で追加）
let watchedProducts = new Map();

// =====================================
// LINEメッセージ受信部分
// =====================================
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: 'success' });
  } catch (err) {
    console.error('エラー発生:', err);
    res.status(500).end();
  }
});

// メッセージを処理する関数
async function handleEvent(event) {
  // メッセージイベント以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const userMessage = event.message.text;
  
  console.log(`受信: ${userMessage}`);
  
  // ユーザー情報を取得
  let userName = '顧客';
  try {
    const profile = await lineClient.getProfile(userId);
    userName = profile.displayName;
  } catch (error) {
    console.log('プロフィール取得エラー:', error);
  }
  
  // ChatGPTで返答を生成
  let replyMessage = await generateAIResponse(userMessage, userId);
  
  // Notionに会話を記録
  await saveToNotion({
    userId: userId,
    userName: userName,
    userMessage: userMessage,
    aiReply: replyMessage,
    orderNumber: extractOrderNumber(userMessage)
  });
  
  // LINEに返信
  return lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: replyMessage
  });
}

// =====================================
// ChatGPT応答生成
// =====================================
async function generateAIResponse(message, userId) {
  try {
    // 注文番号が含まれている場合は注文情報を取得
    let orderContext = '';
    const orderNumber = extractOrderNumber(message);
    if (orderNumber) {
      const orderInfo = await getOrderInfo(orderNumber);
      if (orderInfo) {
        orderContext = `
注文情報:
- 注文番号: #${orderInfo.order_number}
- 状態: ${getStatusInJapanese(orderInfo.fulfillment_status)}
- 注文日: ${new Date(orderInfo.created_at).toLocaleDateString('ja-JP')}
- 商品数: ${orderInfo.line_items.length}点
- 配送先: ${orderInfo.shipping_address?.city || ''}
${orderInfo.fulfillments?.[0]?.tracking_number ? `- 追跡番号: ${orderInfo.fulfillments[0].tracking_number}` : ''}
`;
      }
    }
    
    // 在庫確認が含まれている場合
    let inventoryContext = '';
    if (message.includes('在庫') && message.includes('通知')) {
      inventoryContext = '\n在庫通知の設定も可能です。商品名または商品URLを教えてください。';
    }
    
    // ChatGPTに送るプロンプト
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `あなたは親切なオンラインショップのカスタマーサポートAIです。
以下のルールに従って返答してください：
- 丁寧で親しみやすい言葉遣い
- 絵文字を適度に使用（1-2個程度）
- 簡潔でわかりやすい説明
- 注文情報がある場合は必ず含める
- 不明な点は素直に認め、人間のスタッフに確認することを提案

${orderContext}
${inventoryContext}`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    });
    
    return completion.choices[0].message.content;
    
  } catch (error) {
    console.error('ChatGPT エラー:', error);
    return '申し訳ございません。システムに一時的な問題が発生しています。しばらくしてからお試しください。';
  }
}

// =====================================
// Shopify連携機能
// =====================================

// 注文情報を取得
async function getOrderInfo(orderNumber) {
  try {
    const response = await shopifyAxios.get(`/orders.json?name=${orderNumber}&status=any`);
    return response.data.orders[0] || null;
  } catch (error) {
    console.error('Shopify注文取得エラー:', error);
    return null;
  }
}

// 商品情報を取得
async function getProductInfo(productId) {
  try {
    const response = await shopifyAxios.get(`/products/${productId}.json`);
    return response.data.product;
  } catch (error) {
    console.error('Shopify商品取得エラー:', error);
    return null;
  }
}

// 在庫レベルを取得
async function getInventoryLevel(inventoryItemId) {
  try {
    const response = await shopifyAxios.get(`/inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
    return response.data.inventory_levels[0];
  } catch (error) {
    console.error('在庫取得エラー:', error);
    return null;
  }
}

// =====================================
// 自動通知機能
// =====================================

// 発送通知をチェック（5分ごと）
cron.schedule('*/5 * * * *', async () => {
  console.log('発送状況をチェック中...');
  
  try {
    // 過去24時間の注文を取得
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const response = await shopifyAxios.get(`/orders.json?updated_at_min=${yesterday}&status=any`);
    
    for (const order of response.data.orders) {
      // 新しく発送された注文をチェック
      if (order.fulfillment_status === 'fulfilled' && order.tags && !order.tags.includes('notified')) {
        await sendShippingNotification(order);
        // 通知済みタグを追加
        await shopifyAxios.put(`/orders/${order.id}.json`, {
          order: { tags: order.tags + ',notified' }
        });
      }
    }
  } catch (error) {
    console.error('発送チェックエラー:', error);
  }
});

// 在庫復活チェック（10分ごと）
cron.schedule('*/10 * * * *', async () => {
  console.log('在庫状況をチェック中...');
  
  for (const [productId, watchers] of watchedProducts) {
    try {
      const product = await getProductInfo(productId);
      if (product && product.variants[0]) {
        const inventory = await getInventoryLevel(product.variants[0].inventory_item_id);
        
        if (inventory && inventory.available > 0) {
          // 在庫が復活した！
          for (const userId of watchers) {
            await sendInventoryNotification(userId, product);
          }
          // 通知したユーザーをリストから削除
          watchedProducts.delete(productId);
        }
      }
    } catch (error) {
      console.error(`商品${productId}の在庫チェックエラー:`, error);
    }
  }
});

// 発送完了通知を送信
async function sendShippingNotification(order) {
  // 注文に紐づくLINEユーザーIDを取得（実装による）
  // ここでは仮実装
  const userId = await getUserIdFromOrder(order);
  if (!userId) return;
  
  const message = `📦 発送完了のお知らせ

${order.customer.first_name} 様

ご注文商品を発送いたしました！

注文番号: #${order.order_number}
追跡番号: ${order.fulfillments[0]?.tracking_number || '準備中'}

お届け予定日: 2-3営業日

ご不明な点がございましたら、お気軽にお問い合わせください😊`;
  
  try {
    await lineClient.pushMessage(userId, {
      type: 'text',
      text: message
    });
  } catch (error) {
    console.error('発送通知送信エラー:', error);
  }
}

// 在庫復活通知を送信
async function sendInventoryNotification(userId, product) {
  const message = `🎉 在庫復活のお知らせ

お待たせいたしました！
ご希望の商品が再入荷いたしました。

商品名: ${product.title}
価格: ¥${product.variants[0].price}

在庫に限りがございますので、お早めにご検討ください。

▼ご購入はこちら
${process.env.SHOPIFY_STORE_URL}/products/${product.handle}`;
  
  try {
    await lineClient.pushMessage(userId, {
      type: 'text',
      text: message
    });
  } catch (error) {
    console.error('在庫通知送信エラー:', error);
  }
}

// =====================================
// ヘルパー関数
// =====================================

// 注文番号を抽出
function extractOrderNumber(text) {
  const match = text.match(/#(\d+)/);
  return match ? match[1] : null;
}

// ステータスを日本語に変換
function getStatusInJapanese(status) {
  const statusMap = {
    null: '処理中',
    'pending': '保留中',
    'fulfilled': '発送済み',
    'partial': '一部発送済み',
    'restocked': '返品済み'
  };
  return statusMap[status] || status || '確認中';
}

// 注文からLINEユーザーIDを取得（要実装）
async function getUserIdFromOrder(order) {
  // 実際の実装では、顧客のメールアドレスや電話番号から
  // LINEユーザーIDを検索する必要があります
  // ここでは仮実装
  return null;
}

// =====================================
// Notion保存（修正版）
// =====================================
async function saveToNotion(data) {
  try {
    console.log('Notion保存開始...');
    console.log('データベースID:', process.env.NOTION_DATABASE_ID);
    console.log('保存データ:', data);
    
    const properties = {
      'ID': { 
        title: [{ 
          text: { 
            content: `${new Date().toLocaleString('ja-JP')} - ${data.userName}` 
          } 
        }] 
      },
      '顧客名': { 
        title: [{  // rich_text → title に変更
          text: { content: data.userName } 
        }] 
      },
      '顧客LINE_ID': { 
        rich_text: [{ 
          text: { content: data.userId } 
        }] 
      },
      '問い合わせ': { 
        rich_text: [{ 
          text: { content: data.userMessage } 
        }] 
      },
      '作成文章': { 
        rich_text: [{ 
          text: { content: data.aiReply } 
        }] 
      },
      '注文番号': { 
        number: data.orderNumber ? parseInt(data.orderNumber) : null  // rich_text → number に変更
      },
      'ステータス': { 
        multi_select: [{ name: '対応済み' }]  // rich_text → multi_select に変更
      },
      'プラットフォーム': { 
        multi_select: [{ name: 'LINE' }]  // rich_text → multi_select に変更
      },
      '作成日時': { 
        rich_text: [{ 
          text: { content: new Date().toLocaleString('ja-JP') } 
        }] 
      }
    };
    
    console.log('送信プロパティ:', JSON.stringify(properties, null, 2));
    
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: properties
    });
    
    console.log('Notionに保存しました');
  } catch (error) {
    console.error('Notion保存エラー詳細:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
  }
}

// ChatGPT応答生成（簡易版）- OpenAIクレジット問題の一時的解決
async function generateAIResponse(message, userId) {
  try {
    // 注文番号が含まれている場合
    const orderNumber = extractOrderNumber(message);
    if (orderNumber) {
      return `注文番号 #${orderNumber} について確認いたします。少々お待ちください。`;
    }
    
    // 簡単な応答パターン
    const responses = {
      'こんにちは': 'こんにちは！いつもご利用ありがとうございます😊 本日はどのようなご用件でしょうか？',
      'ありがとう': 'こちらこそありがとうございます！他にご不明な点がございましたらお気軽にお申し付けください。',
      '営業時間': '営業時間は平日9:00-18:00です。土日祝日はお休みをいただいております。',
      '送料': '送料は全国一律500円です。5,000円以上のご購入で送料無料となります！',
      '返品': '商品到着後7日以内でしたら返品を承っております。詳しくは返品ポリシーをご確認ください。',
      '在庫': '在庫確認をご希望の商品名を教えていただけますか？確認させていただきます。'
    };
    
    // キーワードマッチング
    for (const [keyword, response] of Object.entries(responses)) {
      if (message.includes(keyword)) {
        return response;
      }
    }
    
    // デフォルト応答
    return 'お問い合わせありがとうございます。内容を確認の上、担当者よりご連絡させていただきます。';
    
  } catch (error) {
    console.error('応答生成エラー:', error);
    return '申し訳ございません。エラーが発生しました。しばらくしてからお試しください。';
  }
}

// =====================================
// サーバー起動
// =====================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`サーバーが起動しました！ポート: ${port}`);
  console.log('Webhookを待機中...');
});

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.send('LINE Bot is running! 🤖');
});