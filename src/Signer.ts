//declare function require(arg:string): any;
import ClientService from './services/ClientService';
import SignerService from './services/SignerService';
import { KeyPairHelper } from './helpers/keypair/KeyPairHelper';
import { ServiceRpcMethods } from './services/ServiceRpcMethods';
import Pair from './models/Pair';
import Client from './models/Client';
import AccessToken from './models/AccessToken';
import EncryptionService from './services/EncryptionService';
import DecryptionService from './services/DecryptionService';
import { KeyPair } from './helpers/keypair/KeyPair';
import ArgumentUtils from './utils/ArgumentUtils';
import KeyPairHelperImpl from './helpers/keypair/KeyPairHelperImpl';
import { StringUtils } from './utils/StringUtils';
import { Configurator } from './helpers/console/Configurator';
import Authenticator from './helpers/Authenticator';

const bodyParser = require('body-parser');
const cors = require('cors');
const express = require('express');
const app = express();

export default class Signer {

    public encryptionService: EncryptionService;
    public decryptionService: DecryptionService;

    private clientService: ClientService;
    private signerService: SignerService;

    constructor() {
        const useLocal: string = ArgumentUtils.getValue('USE_LOCAL', '--useLocal', 'false');

        if (!useLocal || useLocal != 'true') {
            this.initRemote();
        } else {
            this.initLocal();
        }
    }

    private initRemote() {
        const port: string = ArgumentUtils.getValue('LISTEN_PORT', '--port', '3545');
        const nodeHost: string = ArgumentUtils.getValue('HOST_NODE', '--host', '');
        const signerPassPhrase: string = ArgumentUtils.getValue('PASS_PHRASE', '--signerPass', 'signer default pass');
        const authenticatorPublicKey: string = ArgumentUtils.getValue('AUTHENTICATOR_PK', '--authPK');

        this.init(false, parseInt(port), nodeHost, signerPassPhrase, authenticatorPublicKey);
    }

    private initLocal() {
        Configurator.prepareConfiguration().then((result: Map<string, string>) => {
            const port: number = parseInt(result.get('port') || '0');
            const nodeHost: string = result.get('node') || '';
            const clientPassPhrase: string = result.get('mnemonic') || '';

            this.init(true, port, nodeHost, '', '', clientPassPhrase);
        });
    }

    private init(useLocal: boolean,
                 port: number,
                 nodeHost: string,
                 signerPassPhrase: string,
                 authenticatorPublicKey?: string,
                 clientPassPhrase?: string) {

        if (port <= 0) {
            throw `invalid port number: ${port}`;
        }

        if (!nodeHost ||
            nodeHost.length == 0 ||
            nodeHost.indexOf('http') === -1) {
            throw 'For run Signer need setup node host! For setup use' +
            ' "environment": "HOST_NODE" or "command arguments": "--host" ';
        }

        const keyPairHelper: KeyPairHelper = new KeyPairHelperImpl(nodeHost);

        let authenticatorKeyPair: KeyPair | undefined;

        if (useLocal) {
            authenticatorKeyPair = keyPairHelper.createSimpleKeyPair(StringUtils.generateString());
            authenticatorPublicKey = authenticatorKeyPair.getPublicKey();

            signerPassPhrase = StringUtils.generateString();
        }

        const ownKeyPair: KeyPair = keyPairHelper.createSimpleKeyPair(signerPassPhrase);

        if (authenticatorPublicKey === undefined ||
            authenticatorPublicKey === null ||
            authenticatorPublicKey.length === 0) {
            throw 'For run Signer need authenticator public key! For setup use' +
            ' "environment": "AUTHENTICATOR_PK" or "command arguments": "--authPK"';
        }

        this.clientService = new ClientService(keyPairHelper, ownKeyPair, authenticatorPublicKey);
        this.signerService = new SignerService();
        this.encryptionService = new EncryptionService();
        this.decryptionService = new DecryptionService();

        const methods = this.mergeRpcMethods(
            this.clientService,
            this.signerService,
            this.encryptionService,
            this.decryptionService
        );

        this.initService(methods, port);

        if (clientPassPhrase && authenticatorKeyPair) {
            const authenticator: Authenticator = new Authenticator(authenticatorKeyPair);
            this.clientService.registerClient(authenticator.prepareAuth(clientPassPhrase), true);
        }
    }

    private initService(methods: object, port: number) {
        app.use(cors());
        app.use(bodyParser.urlencoded({extended: false}));
        app.use(bodyParser.text({type: '*/*'}));

        app.post('/', (request, response, next) => {
            const json = JSON.parse(request.body);
            const method = json.method;

            if (methods.hasOwnProperty(method)) {
                new Promise(resolve => {
                    const origin: string = (request.headers.origin === undefined)
                        ? 'http://localhost'
                        : request.headers.origin;

                    const result = methods[method](json.params, origin);

                    const data: any = {
                        'jsonrpc': '2.0',
                        result: result,
                        id: json.id
                    };

                    resolve(data);
                }).then(result => response.send(result))
                    .catch(reason => next(reason));
            } else {
                next();
            }
        });

        app.listen(port, () => {
            console.log('Signer running on port', port);
        });
    }

    private mergeRpcMethods(...rpcMethods: Array<ServiceRpcMethods>): object {
        const result: any = {};

        for (let service of rpcMethods) {
            const map: Map<string, Pair<Function, any>> = service.getPublicMethods();
            map.forEach((value, key) => {
                result[key] = (args: any, origin: string) => {
                    if (value.second == null || value.second == undefined) {
                        return value.first();
                    }

                    let client: Client | undefined = undefined;
                    let arg: any = args.length > 0 ? args[0] : {};

                    const model: any = typeof arg != null && typeof value.second != 'string'
                        ? Object.assign(new value.second(), arg)
                        : arg;

                    if (model instanceof AccessToken) {
                        client = this.clientService.getClient(model.accessToken);
                        if (client && (client.origin !== origin && !client.local)) {
                            throw 'access denied';
                        }
                    }

                    return value.first(model, client, origin);
                };
            });
        }

        return result;
    }

}

new Signer();
