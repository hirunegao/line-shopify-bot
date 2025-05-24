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

// テンプレートキャッシュ
let responseTemplates = null;
let templateLastUpdated = null;

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
  
  // メッセージを分析してコンテキストを準備
  const context = await analyzeMessage(userMessage, userId);
  
  // ChatGPTで返答を生成
  let replyMessage = await generateAIResponse(userMessage, context);
  
  // Notionに会話を記録（エラーハンドリング改善）
  try {
    await saveToNotion({
      userId: userId,
      userName: userName,
      userMessage: userMessage,
      aiReply: replyMessage,
      orderNumber: context.orderNumber,
      status: context.requiresHumanReview ? '要確認' : '対応済み',
      category: context.category
    });
  } catch (notionError) {
    console.error('Notion保存エラー（続行）:', notionError.message);
    // Notionエラーでも返信は続行
  }
  
  // LINEに返信
  return lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: replyMessage
  });
}

// =====================================
// メッセージ分析とコンテキスト作成
// =====================================
async function analyzeMessage(message, userId) {
  const context = {
    orderNumber: null,
    orderInfo: null,
    category: null,
    requiresHumanReview: false,
    customerHistory: null
  };
  
  // 注文番号の抽出（複数パターンに対応）
  const orderPatterns = [
    /#(\d+)/,                    // #1234
    /注文番号[\s:：]*(\d+)/,     // 注文番号：1234
    /オーダー[\s:：]*(\d+)/,     // オーダー：1234
    /(\d{4,})/                   // 4桁以上の数字
  ];
  
  for (const pattern of orderPatterns) {
    const match = message.match(pattern);
    if (match) {
      context.orderNumber = match[1];
      break;
    }
  }
  
  // 注文情報を取得
  if (context.orderNumber) {
    context.orderInfo = await getOrderDetails(context.orderNumber);
  }
  
  // カテゴリー分類
  context.category = categorizeMessage(message);
  
  // 顧客履歴を取得
  context.customerHistory = await getCustomerHistory(userId);
  
  // 人間の確認が必要か判定
  context.requiresHumanReview = shouldEscalateToHuman(message, context);
  
  return context;
}

// メッセージのカテゴリー分類
function categorizeMessage(message) {
  const categories = {
    '配送・発送': ['発送', '配送', '届', 'いつ', '到着', '追跡'],
    '注文確認': ['注文', '確認', '状況', 'ステータス'],
    'キャンセル・返品': ['キャンセル', '返品', '返金', '交換'],
    '在庫': ['在庫', '入荷', '売り切れ', '再入荷'],
    '商品': ['商品', 'サイズ', '色', '詳細'],
    '支払い': ['支払', '決済', '振込', 'クレジット'],
    '営業・その他': ['営業時間', '休み', '問い合わせ']
  };
  
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => message.includes(keyword))) {
      return category;
    }
  }
  
  return 'その他';
}

// 人間の対応が必要か判定
function shouldEscalateToHuman(message, context) {
  // エスカレーション条件
  const escalationKeywords = ['クレーム', '怒', '最悪', '詐欺', '訴訟', '弁護士'];
  const hasEscalationKeyword = escalationKeywords.some(keyword => message.includes(keyword));
  
  // キャンセル・返品は人間が確認
  const needsHumanCategories = ['キャンセル・返品'];
  const needsHumanReview = needsHumanCategories.includes(context.category);
  
  return hasEscalationKeyword || needsHumanReview;
}

// =====================================
// Shopify連携（詳細版）
// =====================================
async function getOrderDetails(orderNumber) {
  try {
    // 注文番号で検索
    const response = await shopifyAxios.get(`/orders.json?name=${orderNumber}&status=any`);
    
    if (response.data.orders.length === 0) {
      return null;
    }
    
    const order = response.data.orders[0];
    
    // 詳細情報を整理
    return {
      orderNumber: order.order_number,
      status: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      createdAt: order.created_at,
      totalPrice: order.total_price,
      currency: order.currency,
      items: order.line_items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      customer: {
        name: `${order.customer.first_name} ${order.customer.last_name}`,
        email: order.customer.email
      },
      shippingAddress: order.shipping_address,
      trackingInfo: order.fulfillments.map(f => ({
        trackingNumber: f.tracking_number,
        trackingCompany: f.tracking_company,
        trackingUrl: f.tracking_url,
        status: f.status
      }))
    };
  } catch (error) {
    console.error('Shopify注文取得エラー:', error);
    return null;
  }
}

// 顧客履歴を取得
async function getCustomerHistory(userId) {
  try {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        property: '顧客LINE_ID',
        rich_text: {
          contains: userId
        }
      },
      sorts: [
        {
          property: '作成日時',
          direction: 'descending'
        }
      ],
      page_size: 5
    });
    
    return response.results;
  } catch (error) {
    console.error('顧客履歴取得エラー:', error);
    return [];
  }
}

// =====================================
// テンプレート管理
// =====================================
async function loadResponseTemplates() {
  try {
    // キャッシュチェック（5分間有効）
    if (responseTemplates && templateLastUpdated && 
        (Date.now() - templateLastUpdated) < 5 * 60 * 1000) {
      return responseTemplates;
    }
    
    // NotionからテンプレートページのIDを環境変数で指定
    const templatePageId = process.env.NOTION_TEMPLATE_PAGE_ID;
    if (!templatePageId) {
      console.log('テンプレートページIDが設定されていません');
      return getDefaultTemplates();
    }
    
    // Notionからテンプレートを取得
    const response = await notion.blocks.children.list({
      block_id: templatePageId,
      page_size: 100
    });
    
    // テンプレートを解析
    const templates = {};
    let currentCategory = null;
    
    for (const block of response.results) {
      if (block.type === 'heading_2') {
        currentCategory = block.heading_2.rich_text[0]?.plain_text;
      } else if (block.type === 'paragraph' && currentCategory) {
        const text = block.paragraph.rich_text[0]?.plain_text;
        if (text) {
          if (!templates[currentCategory]) {
            templates[currentCategory] = [];
          }
          templates[currentCategory].push(text);
        }
      }
    }
    
    responseTemplates = templates;
    templateLastUpdated = Date.now();
    
    console.log('テンプレート読み込み完了:', Object.keys(templates));
    return templates;
    
  } catch (error) {
    console.error('テンプレート読み込みエラー:', error);
    return getDefaultTemplates();
  }
}

// デフォルトテンプレート
function getDefaultTemplates() {
  return {
    '配送確認': [
      'ご注文番号 #{orderNumber} の配送状況をお調べいたします。',
      '現在の配送状況：{status}',
      '追跡番号：{trackingNumber}',
      'お届け予定日：{deliveryDate}'
    ],
    '注文確認': [
      'ご注文ありがとうございます。',
      '注文番号：#{orderNumber}',
      'ご注文日：{orderDate}',
      '合計金額：¥{totalPrice}'
    ],
    '在庫確認': [
      '在庫状況を確認いたします。',
      '商品名：{productName}',
      '在庫状況：{stockStatus}'
    ],
    'お詫び': [
      'この度はご不便をおかけして申し訳ございません。',
      '早急に確認し、対応させていただきます。'
    ],
    '挨拶': [
      'いらっしゃいませ！本日はどのようなご用件でしょうか？',
      'お問い合わせありがとうございます。'
    ]
  };
}

// =====================================
// ChatGPT応答生成（改善版）
// =====================================
async function generateAIResponse(message, context) {
  try {
    // テンプレートを読み込み
    const templates = await loadResponseTemplates();
    
    // システムプロンプトを構築
    let systemPrompt = `あなたは「昼寝のソムリエshop HIRUNEGAO」の親切で丁寧なカスタマーサポートAIです。

基本ルール：
- 丁寧で親しみやすい言葉遣い
- 適度に絵文字を使用（1-2個程度）
- 簡潔でわかりやすい説明
- 不明な点は素直に認め、確認することを伝える
- お客様の気持ちに寄り添う対応

利用可能なテンプレート：
${JSON.stringify(templates, null, 2)}
`;
    
    // コンテキスト情報を追加
    if (context.orderInfo) {
      systemPrompt += `

注文情報：
- 注文番号: #${context.orderInfo.orderNumber}
- 注文日: ${new Date(context.orderInfo.createdAt).toLocaleDateString('ja-JP')}
- 合計金額: ¥${context.orderInfo.totalPrice}
- 配送状況: ${getStatusInJapanese(context.orderInfo.fulfillmentStatus)}
`;
      
      if (context.orderInfo.trackingInfo.length > 0) {
        const tracking = context.orderInfo.trackingInfo[0];
        systemPrompt += `- 追跡番号: ${tracking.trackingNumber || '準備中'}
- 配送業者: ${tracking.trackingCompany || '確認中'}
`;
      }
      
      systemPrompt += `
商品明細：
${context.orderInfo.items.map(item => 
  `- ${item.name} × ${item.quantity}個 (¥${item.price})`
).join('\n')}
`;
    }
    
    if (context.customerHistory && context.customerHistory.length > 0) {
      systemPrompt += `

過去の問い合わせ履歴あり（${context.customerHistory.length}件）
`;
    }
    
    if (context.requiresHumanReview) {
      systemPrompt += `

注意：このお客様は人間のスタッフによる対応が必要な可能性があります。
慎重に対応し、必要に応じて「担当者に確認いたします」と伝えてください。
`;
    }
    
    // ChatGPT APIを呼び出し
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: `カテゴリー: ${context.category}\nお客様のメッセージ: ${message}`
        }
      ],
      temperature: 0.7,
      max_tokens: 300
    });
    
    let response = completion.choices[0].message.content;
    
    // 人間の確認が必要な場合は注記を追加
    if (context.requiresHumanReview) {
      response += '\n\n※こちらの件は担当者からも改めてご連絡させていただきます。';
    }
    
    return response;
    
  } catch (error) {
    console.error('ChatGPT エラー:', error);
    
    // エラー時の代替応答
    if (context.orderNumber && context.orderInfo) {
      return `ご注文番号 #${context.orderNumber} について確認いたしました。
現在の状況：${getStatusInJapanese(context.orderInfo.fulfillmentStatus)}
詳細については、担当者より改めてご連絡させていただきます。`;
    }
    
    return 'お問い合わせありがとうございます。内容を確認の上、担当者よりご連絡させていただきます。';
  }
}

// =====================================
// Notion保存（改善版）
// =====================================
async function saveToNotion(data) {
  try {
    // IDフィールドの自動生成
    const autoId = Date.now().toString();
    
    const properties = {
      'ID': { 
        title: [{ 
          text: { 
            content: autoId
          } 
        }] 
      },
      '顧客名': { 
        rich_text: [{ 
          text: { content: data.userName || '不明' } 
        }] 
      },
      '顧客LINE_ID': { 
        rich_text: [{ 
          text: { content: data.userId } 
        }] 
      },
      '問い合わせ': { 
        rich_text: [{ 
          text: { content: data.userMessage || '' } 
        }] 
      },
      '作成文章': { 
        rich_text: [{ 
          text: { content: data.aiReply || '' } 
        }] 
      },
      'ステータス': { 
        select: { name: data.status || '対応済み' }
      },
      'プラットフォーム': { 
        select: { name: 'LINE' }
      },
      '作成日時': { 
        rich_text: [{ 
          text: { content: new Date().toLocaleString('ja-JP') } 
        }] 
      }
    };
    
    // 注文番号がある場合のみ追加
    if (data.orderNumber) {
      properties['注文番号'] = { 
        number: parseInt(data.orderNumber)
      };
    }
    
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: properties
    });
    
    console.log('Notionに保存しました:', autoId);
    
  } catch (error) {
    console.error('Notion保存エラー:', error.message);
    throw error; // エラーを上位に伝播
  }
}

// =====================================
// 自動通知機能（改善版）
// =====================================

// 発送通知をチェック（5分ごと）
cron.schedule('*/5 * * * *', async () => {
  console.log('発送状況をチェック中...');
  
  try {
    // 過去24時間の注文を取得
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const response = await shopifyAxios.get(`/orders.json?updated_at_min=${yesterday}&status=any&limit=50`);
    
    for (const order of response.data.orders) {
      // 新しく発送された注文をチェック
      if (order.fulfillment_status === 'fulfilled' && 
          order.tags && 
          !order.tags.includes('line_notified')) {
        
        // 顧客のLINE IDを検索
        const lineUserId = await findLineUserIdByEmail(order.customer.email);
        if (lineUserId) {
          await sendShippingNotification(lineUserId, order);
          
          // 通知済みタグを追加
          await shopifyAxios.put(`/orders/${order.id}.json`, {
            order: { 
              tags: order.tags ? `${order.tags},line_notified` : 'line_notified'
            }
          });
        }
      }
    }
  } catch (error) {
    console.error('発送チェックエラー:', error);
  }
});

// メールアドレスからLINE IDを検索
async function findLineUserIdByEmail(email) {
  try {
    // Notionで顧客メールアドレスを検索
    const response = await notion.databases.query({
      database_id: process.env.NOTION_CUSTOMER_DB_ID, // 顧客マスターDB
      filter: {
        property: 'メールアドレス',
        email: {
          equals: email
        }
      }
    });
    
    if (response.results.length > 0) {
      return response.results[0].properties['LINE_ID']?.rich_text[0]?.plain_text;
    }
    
    return null;
  } catch (error) {
    console.error('LINE ID検索エラー:', error);
    return null;
  }
}

// 発送完了通知を送信
async function sendShippingNotification(userId, order) {
  const tracking = order.fulfillments[0];
  const message = `📦 発送完了のお知らせ

${order.customer.first_name} 様

お待たせいたしました！
ご注文いただいた商品を発送いたしました。

【ご注文内容】
注文番号: #${order.order_number}
${order.line_items.map(item => 
  `・${item.name} × ${item.quantity}`
).join('\n')}

【配送情報】
${tracking?.tracking_company || '配送業者確認中'}
追跡番号: ${tracking?.tracking_number || '準備中'}
${tracking?.tracking_url ? `追跡URL: ${tracking.tracking_url}` : ''}

お届け予定: 2-3営業日

商品の到着まで今しばらくお待ちください。
ご不明な点がございましたら、お気軽にお問い合わせください😊`;
  
  try {
    await lineClient.pushMessage(userId, {
      type: 'text',
      text: message
    });
    console.log('発送通知送信完了:', order.order_number);
  } catch (error) {
    console.error('発送通知送信エラー:', error);
  }
}

// =====================================
// ヘルパー関数
// =====================================

// ステータスを日本語に変換
function getStatusInJapanese(status) {
  const statusMap = {
    null: '処理中',
    'pending': '保留中',
    'fulfilled': '発送済み',
    'partial': '一部発送済み',
    'restocked': '返品済み',
    'paid': '支払い済み',
    'partially_paid': '一部支払い済み',
    'refunded': '返金済み',
    'voided': 'キャンセル済み'
  };
  return statusMap[status] || status || '確認中';
}

// =====================================
// サーバー起動
// =====================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`サーバーが起動しました！ポート: ${port}`);
  console.log('Webhookを待機中...');
  
  // 起動時にテンプレートを読み込み
  loadResponseTemplates().then(() => {
    console.log('初期テンプレート読み込み完了');
  });
});

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.send('LINE Bot is running! 🤖');
});

// 手動でテンプレートをリロード
app.get('/reload-templates', async (req, res) => {
  responseTemplates = null;
  await loadResponseTemplates();
  res.json({ message: 'Templates reloaded', templates: Object.keys(responseTemplates || {}) });
});