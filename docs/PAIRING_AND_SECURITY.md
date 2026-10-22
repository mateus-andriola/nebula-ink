# Guia de Pareamento, Rede Local e Segurança

## 1. Fluxo de Pareamento por QR Code

1. Ao abrir o modal **Parear Dispositivo** no aplicativo Desktop, o servidor gera um **token temporário criptograficamente aleatório** (`pairingToken`, 128 bits de entropia) com validade estrita de **5 minutos** (`300.000 ms`) e **uso único**.
2. O QR Code codifica uma estrutura JSON compacta:
   ```json
   {
     "v": 1,
     "host": "192.168.100.8",
     "candidates": ["192.168.100.8"],
     "port": 8765,
     "protocol": "ws",
     "pairingToken": "tkn_...",
     "expiresAt": 1760985300000,
     "certFingerprint": "sha256:..."
   }
   ```
3. **Sem Credenciais Permanentes**: O QR Code nunca contém chaves mestras ou credenciais estáticas. Caso expire ou seja consumido, um novo token deve ser gerado.
4. **Aprovação Explícita de Dispositivo**:
   - Quando um novo Samsung Galaxy S24 Ultra envia `session.start` com o `pairingToken`, o Desktop exibe o nome e identificador do dispositivo (`Samsung Galaxy S24 Ultra — s24u-...`) para aprovação explícita do usuário (ou permite pré-autorização de sessão única durante a janela do QR Code).
   - Após aprovado, o servidor emite um `sessionResumeToken` vinculado apenas àquela sessão e invalida imediatamente o `pairingToken` do QR Code.

---

## 2. Seleção de Interface de Rede e Tratamento de Isolamento Wi-Fi

### Múltiplos Adaptadores no Windows
Conforme diagnosticado neste computador (`docs/ENVIRONMENT_REPORT.md`), existem múltiplos adaptadores IPv4 ativos:
- `192.168.100.8` (Wi-Fi — rede local acessível pelo celular)
- `25.31.138.90` (Hamachi VPN — inacessível via LAN Wi-Fi)
- `172.18.96.1` (vEthernet Default Switch — switch interno WSL/Hyper-V)

O servidor Desktop classifica automaticamente as interfaces de rede, priorizando sub-redes Wi-Fi/LAN físicas (`192.168.x.x`, `10.x.x.x`) e ignorando interfaces de loopback ou túneis conhecidos, além de permitir ao usuário alternar a interface de escuta diretamente na janela de pareamento.

### Isolamento de Clientes (AP Isolation) e Firewall
- Se o roteador Wi-Fi estiver com **Client Isolation / AP Isolation** ativo (comum em redes corporativas, universitárias ou de visitantes), pacotes TCP diretos entre `192.168.100.x` (celular) e `192.168.100.8` (desktop) serão bloqueados na camada 2.
- Caso o aplicativo Android não receba resposta ao handshake WebSocket dentro de `4000 ms`, ele exibe um diagnóstico claro instruindo o usuário a verificar:
  1. Se ambos estão no mesmo SSID Wi-Fi (e não em sub-redes Guest isoladas).
  2. Se o Firewall do Windows permite tráfego na porta do servidor local.
  3. Alternativa de conexão via **USB Debugging (`adb reverse tcp:8765 tcp:8765`)**, permitindo usar `ws://127.0.0.1:8765` mesmo em redes Wi-Fi com isolamento estrito entre clientes.

---

## 3. Segurança e Limites Conhecidos na Rede Local

### Medidas Implementadas
- **Autenticação obrigatória no primeiro pacote**: Qualquer mensagem enviada em um socket antes de `session.start` ou `session.resume` válido resulta em `session.error` (`UNAUTHORIZED`) e fechamento imediato da conexão.
- **Limite de tamanho de payload**: Rejeição imediata de quadros maiores que `512 KB`.
- **Validação estrutural e de referências**: Todos os campos (`operationId`, `pageId`, `notebookId`, coordenadas finitas, intervalos de pressão `[0, 1]`, cores hexadecimais) são validados antes de tocar no banco SQLite.
- **Proteção contra Replay / Duplicação**: O registro transacional de `operationId` impede que o reenvio acidental ou malicioso da mesma mensagem duplique traços ou apague objetos distintos.
- **Suporte a TLS (`wss://`) com Pinning de Certificado**: O servidor suporta configuração de certificado TLS local autoassinado cujo hash SHA-256 (`certFingerprint`) é transmitido dentro do QR Code lido opticamente, permitindo que o cliente Android valide explicitamente o certificado sem depender de CAs públicas para IPs privados.

### Limites da Segurança na Rede Local
- Quando executado em modo `ws://` (sem TLS configurado) para desenvolvimento rápido, o tráfego na LAN local não é criptografado na camada de aplicação (dependendo da criptografia WPA2/WPA3 do Wi-Fi). Para ambientes compartilhados não confiáveis, recomenda-se habilitar o modo TLS (`wss://`) ou utilizar o túnel USB (`adb reverse`).
