const crypto = require('crypto');
const log = require('electron-log');
const request = require('async-request');
const axios = require('axios');
const { getStorage } = require('../storage');
const {getWindow} = require("../window_utils");
const {machine_id} = require("../web3_utils");

class Project {

    constructor({slug, id= crypto.randomBytes(16).toString('hex'), count = 0, contract_address='',setup = true, proxies = []}) {
        this.traitsMap = new Map();

        this.slug = slug;
        this.id = id;
        this.global_cursor = '';
        this.network = '';
        this.schema = 'ERC721';

        // making sure the project has been added to the DB before attempting to update.
        this.setup = setup;

        this.proxies = proxies;

        this.api_keys = ['852d4657fe794045abf12f206af777ad', '2e7ef0ac679f4860bbe49a34a98cf5ac', 'a97239276ae0463297a18436a424c676', '2f603e64a3ea42f9b0cb39466ca036df'];

        this.contract_address = contract_address;
        this.count = count;
        this.db = getStorage();
        this.active = false;
    }

    async getAssetsByTrait (network, slug, cursor, api_key) {

        const p = this.proxies[Math.floor(Math.random() * this.proxies.length)];

        log.info(`[Project] Checking project ${slug} cursor ${cursor} with Proxy ${p}`);

        const asset_url = `https://${network}api.opensea.io/api/v1/assets?collection_slug=${slug}&limit=50&cursor=${cursor}`

        try {

            const res = await request(asset_url, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36',
                    "Accept": "application/json",
                    "X-API-KEY": api_key
                },
                proxy: this.proxies.length === 0 ? '' : `http://${p.user}:${p.pass}@${p.host}:${p.port}`
            });

            if(res.statusCode !== 200) {

                if(res.statusCode === 401) {
                    log.info(`[Project] Status is ${res.statusCode} Proxy: ${p}`);
                    this.sendMessage('project-status-update', {
                        error: 1,
                        slug: this.slug,
                        message: `Throttled ${res.statusCode}`
                    })
                    return;
                }

                log.info(`[Project] Status is ${res.statusCode} ${res.body} Proxy: ${p}`);
                this.sendMessage('project-status-update', {
                    error: 3,
                    slug: this.slug,
                    message: `Unknown ${res.statusCode}`
                })
                this.throttled = true;
                return;
            }

            const json_body = JSON.parse(res.body);

            for(const asset of json_body.assets) {

                if(this.contract_address.length === 0) {
                    this.contract_address = asset.asset_contract.address;
                }

                if(asset.asset_contract.schema_name !== this.schema) {
                    this.schema = asset.asset_contract.schema_name;
                }

                for(const trait of asset.traits) {

                    const trait_str = `${trait.trait_type};${trait.value}`.replace(".", "");
                    const trait_exists = this.traitsMap.has(trait_str);

                    if(trait_exists) {

                        if(this.traitsMap.get(trait_str).includes(asset.token_id)) {
                            continue;
                        }
                        this.traitsMap.get(trait_str).push(asset.token_id);

                    } else {
                        this.traitsMap.set(trait_str, [asset.token_id]);
                    }

                }

                this.count++;
            }

            if(this.setup) {
                //ultra-miners
                this.db.projects.update({id: this.id}, {
                $set: {
                    count: this.count,
                    global_cursor: this.global_cursor,
                    data: Object.fromEntries(this.traitsMap),
                    contract_address: this.contract_address,
                    schema: this.schema
                }}, {}, function(err, numReplaced) {

                    if(err) {
                        log.info(`[Project] Error while saving data ${err}`);
                        return;
                    }

                    log.info(`[Project] Saved data successfully numReplaced: ${numReplaced}.`);
                })

            }

            if(this.active) {
                this.sendMessage('project-status-update', {
                    error: 0,
                    slug: this.slug,
                    message: `Got Assets ${this.count}`
                })
            }


            log.info(`[Project] Success got asset with Proxy: ${p} next Cursor: ${json_body.next === null ? 'NULL' : json_body.next} Count: ${this.count}`);
            log.info("-----------------------------------------");

            return json_body.next === null ? '' : json_body.next;
        } catch(e) {
            this.sendMessage('project-status-update', {
                error: 2,
                slug: this.slug,
                message: `Error ${e.message}`
            })
            log.info(`[Project] Error ${e.message} while getting asset Proxy: ${p} ${this.count}`);
            log.info("-----------------------------------------");
            return cursor; // if error, return the cursor we just went with
        }

    }

    startFetchingAssets() {

        log.info(`[Project] Started to fetch assets.`);

        if(typeof this.interval !== 'undefined') {
            log.info("[Project] this project is already fetching assets.");
            return;
        }

        this.active = true;

        let api_key = '';
        let throttle_counter = 0;
        let key_index = 0;

        this.interval = setInterval(async () => {

            if(this.throttled) {

                log.info(`[Project] API Keys throttled ${throttle_counter}.`);

                throttle_counter++;

                this.sendMessage('project-status-update', {
                    error: 4,
                    slug: this.slug,
                    message: `Waiting ${4 - throttle_counter}s`
                })

                if(throttle_counter === 4) {
                    this.throttled = false;
                    throttle_counter = 0;
                    log.info(`[Project] Starting to fetch assets again ${throttle_counter}.`);
                }

                return;
            }

            if(key_index >= this.api_keys.length) {
                key_index = 0;
            }

            api_key = this.api_keys[key_index];

            const res = await this.getAssetsByTrait(this.network, this.slug, this.global_cursor, api_key);

            if(typeof res !== 'undefined' && res.length === 0) {
                log.info(`[Project] Finished with ${this.count} assets captured.`);
                this.sendMessage('project-status-update', {
                    error: 5,
                    slug: this.slug,
                    message: `Finished`
                })
                clearInterval(this.interval);
                this.active = false;
                this.sendMessage('project-status-finished');
            }

            if(typeof res !== 'undefined') {
                this.global_cursor = res;
            } else {
                log.info(`[Project] Error, sending with old cursor, ${this.global_cursor}`);
            }

            key_index++;

        }, 1.25 * 1000);

    }

    stop() {
        if(typeof this.interval === 'undefined') {
            log.info("[Project] this project is not running.");
            return;
        }

        clearInterval(this.interval);
        this.active = false;

        this.sendMessage('project-status-update', {
            error: 6,
            slug: this.slug,
            message: `Stopped`
        })
    }

    sendMessage(channel, data) {
        getWindow().webContents.send(channel, data);
    }
}

module.exports = {
    Project
}