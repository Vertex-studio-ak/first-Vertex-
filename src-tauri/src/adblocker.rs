use adblock::Engine;
use adblock::lists::{ParseOptions, FilterFormat};
use adblock::request::Request;
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot};

struct AdblockRequest {
    url: String,
    source_url: String,
    resource_type: String,
    reply: oneshot::Sender<bool>,
}

static SENDER: OnceLock<mpsc::Sender<AdblockRequest>> = OnceLock::new();

/// Initialize adblock engine with built-in filter rules on a dedicated thread
pub fn init() {
    let (tx, mut rx) = mpsc::channel::<AdblockRequest>(32);
    SENDER.set(tx).ok();

    std::thread::spawn(move || {
        let rules = get_default_rules();
        let mut filter_set = adblock::lists::FilterSet::new(false);
        filter_set.add_filters(&rules, ParseOptions { format: FilterFormat::Standard, ..Default::default() });
        let engine = Engine::from_filter_set(filter_set, true);

        while let Some(req) = rx.blocking_recv() {
            let matched = if let Ok(request) = Request::new(&req.url, &req.source_url, &req.resource_type) {
                engine.check_network_request(&request).matched
            } else {
                false
            };
            let _ = req.reply.send(matched);
        }
    });
}

/// Check if a URL should be blocked (async actor request)
pub async fn should_block(url: String, source_url: String, resource_type: String) -> bool {
    let tx = match SENDER.get() {
        Some(tx) => tx,
        None => return false,
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    let req = AdblockRequest { url, source_url, resource_type, reply: reply_tx };
    if tx.send(req).await.is_ok() {
        reply_rx.await.unwrap_or(false)
    } else {
        false
    }
}

/// Basic built-in filter rules (subset of EasyList)
fn get_default_rules() -> Vec<String> {
    vec![
        // Major Ad Networks
        "||doubleclick.net^".to_string(),
        "||googlesyndication.com^".to_string(),
        "||googleadservices.com^".to_string(),
        "||googleads.g.doubleclick.net^".to_string(),
        "||adservice.google.com^".to_string(),
        "||adnxs.com^".to_string(),
        "||amazon-adsystem.com^".to_string(),
        "||ads.twitter.com^".to_string(),
        "||advertising.com^".to_string(),
        "||outbrain.com^".to_string(),
        "||taboola.com^".to_string(),
        "||criteo.com^".to_string(),
        "||casalemedia.com^".to_string(),
        "||openx.net^".to_string(),
        "||pubmatic.com^".to_string(),
        "||rubiconproject.com^".to_string(),
        "||yieldmo.com^".to_string(),
        "||bidswitch.net^".to_string(),
        "||smartadserver.com^".to_string(),
        "||media.net^".to_string(),
        "||carbonads.net^".to_string(),
        "||adroll.com^".to_string(),
        "||moatads.com^".to_string(),
        "||gemini.yahoo.com^".to_string(),

        // Trackers & Analytics
        "||google-analytics.com^".to_string(),
        "||googletagmanager.com^".to_string(),
        "||analytics.google.com^".to_string(),
        "||analytics.twitter.com^".to_string(),
        "||mc.yandex.ru^".to_string(),
        "||metrika.yandex.ru^".to_string(),
        "||hotjar.com^".to_string(),
        "||mixpanel.com^".to_string(),
        "||segment.com^".to_string(),
        "||quantserve.com^".to_string(),
        "||scorecardresearch.com^".to_string(),
        "||amplitude.com^".to_string(),
        "||sentry.io^".to_string(),
        "||facebook.com/tr/*".to_string(),
        "||connect.facebook.net^/en_US/fbevents.js".to_string(),
        "||pixel.facebook.com^".to_string(),
        "||bing.com/pixel/*".to_string(),
        "||clarity.ms^".to_string(),
        "||newrelic.com^".to_string(),
        "||inspectlet.com^".to_string(),
        "||mouseflow.com^".to_string(),
        "||fullstory.com^".to_string(),
        "||luckyorange.com^".to_string(),
        "||crazyegg.com^".to_string(),

        // Specific Platforms
        "||ads.youtube.com^".to_string(),
        "||youtube-ui.l.google.com^".to_string(),
        "||ytimg.com/yts/jsbin/player/ad/*".to_string(),
        "||googleadservices.com/pagead/conversion.js".to_string(),
        "||google.com/adsense/search/*".to_string(),
        "||securepubads.g.doubleclick.net^".to_string(),
        "||pagead2.googlesyndication.com^".to_string(),
        "||adclick.g.doubleclick.net^".to_string(),
        "||googleads4.g.doubleclick.net^".to_string(),
        "||ad4.doubleclick.net^".to_string(),
        "||stats.g.doubleclick.net^".to_string(),
        "||pixel.rubiconproject.com^".to_string(),
        "||ads.roblox.com^".to_string(),
        "||ads.twitch.tv^".to_string(),
        "||ads.reddit.com^".to_string(),
        "||ads.vk.com^".to_string(),
        "||target.my.com^".to_string(),
        "||an.yandex.ru^".to_string(),
        "||yandex.ru/ads/*".to_string(),
        "||ad.mail.ru^".to_string(),
        "||static.doubleclick.net^".to_string(),
        "||fls.doubleclick.net^".to_string(),
        "||amazon-adsystem.com/e/dtb/*".to_string(),

        // Generic patterns
        "*/ads/*".to_string(),
        "*/banner/*".to_string(),
        "*/tracking/*".to_string(),
        "*/telemetry/*".to_string(),
        "*/adunit/*".to_string(),
        "*/adserver/*".to_string(),
        "*/advert/*".to_string(),
        "*/pixel/*".to_string(),
        "*/analytics/*".to_string(),
        "*/collect?v=*".to_string(),
        "*/pagead/js/*".to_string(),
        "*/gpt.js".to_string(),
        "*/prebid.js".to_string(),
    ]
}

