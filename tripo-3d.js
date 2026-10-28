// Pegar en la consola de studio.tripo3d.ai con el modelo visible en el visor.
// Saca el modelo de lo que esta dibujado en el canvas (three.js), sin token y
// sin depender de los archivos del CDN ni de librerias externas: GLB completo, OBJ + MTL, texturas y captura.
(() => {
  var S = window.__tripoCanvas || (window.__tripoCanvas = {});
  var TRAMPAS = ['isLOD', 'isSprite'];
  var MAPAS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];

  // --- escena: three pregunta object.isLOD / isSprite a cada mesh en cada render.
  // En un Mesh esas propiedades no existen, la busqueda llega a Object.prototype
  // y ahi la atrapamos con un getter. Asi tenemos la escena sin tocar Vue ni Tres.
  function atrapar(ms) {
    S.scenes = new Set();
    TRAMPAS.forEach(k => Object.defineProperty(Object.prototype, k, {
      configurable: true,
      get() {
        if (this && this.isObject3D) {
          var r = this;
          while (r.parent) r = r.parent;
          if (r.isScene) { S.scenes.add(r); camara(r); }
        }
      },
    }));
    // Tres renderiza a pedido: un resize y un arrastre de 1 px sobre el canvas (y de vuelta)
    // lo obligan a dibujar sin mover el modelo
    window.dispatchEvent(new Event('resize'));
    empujar();
    return new Promise(res => setTimeout(() => {
      TRAMPAS.forEach(k => delete Object.prototype[k]);
      res([...S.scenes]);
    }, ms));
  }

  // guarda el renderer y la camara con que se dibuja cada escena, para sacarle fotos despues
  function camara(scene) {
    if (scene.__tcFoto) return;
    scene.__tcFoto = 1;
    var prev = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, s, camera) {
      (S.cam || (S.cam = new Map())).set(this, { renderer, camera });
      return prev.apply(this, arguments);
    };
  }

  function canvasPrincipal() {
    var cs = [...document.querySelectorAll('canvas[data-engine^="three"]')];
    if (!cs.length) cs = [...document.querySelectorAll('canvas')];
    return cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  }
  function empujar() {
    var c = canvasPrincipal();
    if (!c) return;
    var r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    var ev = (tipo, dx) => c.dispatchEvent(new PointerEvent(tipo, { bubbles: true, clientX: x + dx, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: tipo === 'pointerup' ? 0 : 1, isPrimary: true }));
    ev('pointerdown', 0);
    [1, 0].forEach((dx, i) => setTimeout(() => ev('pointermove', dx), 40 + i * 40));
    setTimeout(() => ev('pointerup', 0), 140);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 600);
  }
  var esHelper = o => { for (; o; o = o.parent) if (/Helper/.test(o.type)) return true; return false; };
  // lo que pone el visor y no es del modelo: plano de sombra, fondos y grillas hechos con shaders, sprites
  var decorado = o => [].concat(o.material).every(m => m && (m.isShadowMaterial || m.isSpriteMaterial ||
    (m.isShaderMaterial || m.isRawShaderMaterial) && !(m.uniforms && Object.values(m.uniforms).some(u => u && u.value && u.value.isTexture)) && o.geometry.attributes.position.count < 2000));
  var visible = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };

  function piezas(scene) {
    var out = [];
    scene.updateMatrixWorld(true);
    scene.traverse(o => {
      if ((o.isMesh || o.isPoints) && o.geometry && o.geometry.attributes.position && visible(o) && !esHelper(o) && !/Line/.test(o.type) && !decorado(o)) out.push(o);
    });
    return out;
  }
  var vertices = list => list.reduce((n, o) => n + o.geometry.attributes.position.count, 0);

  // --- descargas ---
  function guardar(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  var pausa = ms => new Promise(r => setTimeout(r, ms));

  // en three la v de las UV va para arriba si flipY; en glTF va para abajo y en OBJ para arriba
  function imagenPNG(t, voltear) {
    var img = t.image;
    var w = img && (img.width || img.videoWidth), h = img && (img.height || img.videoHeight);
    if (!w || !h) return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    if (img.data) {
      if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length !== w * h * 4) return null;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), w, h), 0, 0);
    } else {
      if (voltear) { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(img, 0, 0);
    }
    return new Promise(r => c.toBlob(r, 'image/png'));
  }

  function texturas(list) {
    var map = new Map();
    list.forEach(o => [].concat(o.material).forEach(m => m && MAPAS.forEach(k => {
      var t = m[k];
      if (t && t.image && !t.isCompressedTexture && !map.has(t)) map.set(t, k + '-' + map.size);
    })));
    return map;
  }

  // GLB escrito a mano: la geometria ya viene con la posicion del mundo aplicada,
  // asi no dependemos del GLTFExporter (se trababa con modelos de ~1M vertices)
  // three le aplica a las UV la transformacion de la textura (repeat/offset/rotation) en el shader.
  // Hay visores que la usan para UV cuantizadas (Meshy: repeat ~16): sin hornearla, las texturas salen corridas
  function uvTextura(o) {
    var m = [].concat(o.material)[0], t = m && MAPAS.map(k => m[k]).find(x => x && x.isTexture);
    if (!t) return (u, v) => [u, v];
    if (t.matrixAutoUpdate) t.updateMatrix();
    var e = t.matrix.elements;
    return (u, v) => [e[0] * u + e[3] * v + e[6], e[1] * u + e[4] * v + e[7]];
  }

  async function glb(list, name, avance) {
    var json = {
      asset: { version: '2.0', generator: 'tripo-descargas canvas.js' },
      scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [],
      buffers: [{ byteLength: 0 }], materials: [], textures: [], images: [],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    };
    var partes = [], offset = 0;
    var vista = (typed, target) => {
      if (offset % 4) { partes.push(new Uint8Array(4 - offset % 4)); offset += 4 - offset % 4; }
      partes.push(typed);
      json.bufferViews.push(Object.assign({ buffer: 0, byteOffset: offset, byteLength: typed.byteLength }, target ? { target } : {}));
      offset += typed.byteLength;
      return json.bufferViews.length - 1;
    };
    var COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    var accesor = (typed, type, extra) => {
      var comp = typed instanceof Float32Array ? 5126 : typed instanceof Uint32Array ? 5125 : 5123;
      json.accessors.push(Object.assign({
        bufferView: vista(typed, type === 'SCALAR' && comp !== 5126 ? 34963 : 34962),
        componentType: comp, count: typed.length / COMP[type], type,
      }, extra));
      return json.accessors.length - 1;
    };

    var texs = new Map();
    async function textura(t) {
      if (!t || !t.image || t.isCompressedTexture) return undefined;
      if (texs.has(t)) return texs.get(t);
      var b = await imagenPNG(t, t.flipY);
      if (!b) { texs.set(t, undefined); return undefined; }
      json.images.push({ bufferView: vista(new Uint8Array(await b.arrayBuffer())), mimeType: 'image/png' });
      json.textures.push({ sampler: 0, source: json.images.length - 1 });
      texs.set(t, json.textures.length - 1);
      return json.textures.length - 1;
    }
    var mats = new Map();
    async function material(m) {
      if (!m) return undefined;
      if (mats.has(m)) return mats.get(m);
      var c = m.color || { r: 1, g: 1, b: 1 };
      var pbr = {
        baseColorFactor: [c.r, c.g, c.b, m.opacity ?? 1],
        metallicFactor: m.metalness ?? 0,
        roughnessFactor: m.roughness ?? 1,
      };
      var def = { name: m.name || 'mat' + mats.size, pbrMetallicRoughness: pbr, doubleSided: m.side === 2 };
      var i;
      if ((i = await textura(m.map)) !== undefined) pbr.baseColorTexture = { index: i };
      if ((i = await textura(m.roughnessMap || m.metalnessMap)) !== undefined) pbr.metallicRoughnessTexture = { index: i };
      if ((i = await textura(m.normalMap)) !== undefined) def.normalTexture = { index: i };
      if ((i = await textura(m.emissiveMap)) !== undefined) def.emissiveTexture = { index: i };
      if (m.emissive && (m.emissive.r || m.emissive.g || m.emissive.b || m.emissiveMap)) def.emissiveFactor = [m.emissive.r, m.emissive.g, m.emissive.b];
      if (m.transparent && (m.opacity ?? 1) < 1) def.alphaMode = 'BLEND';
      json.materials.push(def);
      mats.set(m, json.materials.length - 1);
      return json.materials.length - 1;
    }

    for (var n = 0; n < list.length; n++) {
      var o = list[n], g = o.geometry, a = g.attributes, e = o.matrixWorld.elements;
      var p = a.position, cnt = p.count;
      avance && avance('pieza ' + (n + 1) + '/' + list.length);
      await pausa(0);

      var pos = new Float32Array(cnt * 3), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (var i = 0; i < cnt; i++) {
        var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        var v = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
        for (var k = 0; k < 3; k++) { pos[i * 3 + k] = v[k]; if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
      }
      var attrs = { POSITION: accesor(pos, 'VEC3', { min, max }) };
      if (a.normal) {
        var nor = new Float32Array(cnt * 3);
        for (i = 0; i < cnt; i++) {
          x = a.normal.getX(i); y = a.normal.getY(i); z = a.normal.getZ(i);
          var nx = e[0] * x + e[4] * y + e[8] * z, ny = e[1] * x + e[5] * y + e[9] * z, nz = e[2] * x + e[6] * y + e[10] * z;
          var l = Math.hypot(nx, ny, nz) || 1;
          nor[i * 3] = nx / l; nor[i * 3 + 1] = ny / l; nor[i * 3 + 2] = nz / l;
        }
        attrs.NORMAL = accesor(nor, 'VEC3');
      }
      if (a.uv) {
        var uv = new Float32Array(cnt * 2);
        var tuv = uvTextura(o);
        for (i = 0; i < cnt; i++) { var w = tuv(a.uv.getX(i), a.uv.getY(i)); uv[i * 2] = w[0]; uv[i * 2 + 1] = w[1]; }
        attrs.TEXCOORD_0 = accesor(uv, 'VEC2');
      }
      if (a.color) {
        var ic = a.color.itemSize === 4 ? 4 : 3, col = new Float32Array(cnt * ic);
        for (i = 0; i < cnt; i++) {
          col[i * ic] = a.color.getX(i); col[i * ic + 1] = a.color.getY(i); col[i * ic + 2] = a.color.getZ(i);
          if (ic === 4) col[i * ic + 3] = a.color.getW(i);
        }
        attrs.COLOR_0 = accesor(col, ic === 4 ? 'VEC4' : 'VEC3');
      }

      var total = g.index ? g.index.count : cnt;
      var Tipo = cnt > 65535 ? Uint32Array : Uint16Array;
      var idx = new Tipo(total);
      for (i = 0; i < total; i++) idx[i] = g.index ? g.index.getX(i) : i;
      var mlist = [].concat(o.material);
      var grupos = Array.isArray(o.material) && g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
      var prims = [];
      for (var gr of grupos) {
        var desde = gr.start, hasta = Math.min(total, gr.start + (isFinite(gr.count) ? gr.count : total));
        var slice = idx.subarray(desde, hasta);
        prims.push({
          attributes: attrs,
          indices: accesor(slice.byteOffset % 4 ? slice.slice() : slice, 'SCALAR'),
          material: await material(mlist[gr.materialIndex || 0]),
          mode: o.isPoints ? 0 : 4,
        });
      }
      json.meshes.push({ name: o.name || 'pieza-' + n, primitives: prims });
      json.nodes.push({ name: o.name || 'pieza-' + n, mesh: json.meshes.length - 1 });
      json.scenes[0].nodes.push(json.nodes.length - 1);
    }
    ['materials', 'textures', 'images'].forEach(k => { if (!json[k].length) delete json[k]; });
    if (!json.textures) delete json.samplers;
    if (offset % 4) { partes.push(new Uint8Array(4 - offset % 4)); offset += 4 - offset % 4; }
    json.buffers[0].byteLength = offset;

    var txt = new TextEncoder().encode(JSON.stringify(json));
    var jlen = Math.ceil(txt.length / 4) * 4;
    var jchunk = new Uint8Array(jlen).fill(0x20);
    jchunk.set(txt);
    var head = new Uint32Array([0x46546c67, 2, 12 + 8 + jlen + 8 + offset, jlen, 0x4e4f534a]);
    var bhead = new Uint32Array([offset, 0x004e4942]);
    guardar(new Blob([head, jchunk, bhead, ...partes], { type: 'model/gltf-binary' }), name + '.glb');
  }

  var r6 = v => Math.round(v * 1e6) / 1e6;

  async function obj(list, name) {
    var texs = texturas(list);
    var lineas = ['# exportado desde el canvas de Tripo', 'mtllib ' + name + '.mtl'];
    var mtl = [];
    var mats = new Map();
    var base = 1;
    list.forEach((o, n) => {
      var g = o.geometry, a = g.attributes, e = o.matrixWorld.elements;
      var p = a.position, no = a.normal, uv = a.uv, idx = g.index;
      lineas.push('o ' + (o.name || 'pieza-' + n).replace(/\s+/g, '_'));
      for (var i = 0; i < p.count; i++) {
        var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        lineas.push('v ' + r6(e[0] * x + e[4] * y + e[8] * z + e[12]) + ' ' + r6(e[1] * x + e[5] * y + e[9] * z + e[13]) + ' ' + r6(e[2] * x + e[6] * y + e[10] * z + e[14]));
      }
      if (no) for (i = 0; i < no.count; i++) {
        x = no.getX(i); y = no.getY(i); z = no.getZ(i);
        var nx = e[0] * x + e[4] * y + e[8] * z, ny = e[1] * x + e[5] * y + e[9] * z, nz = e[2] * x + e[6] * y + e[10] * z;
        var l = Math.hypot(nx, ny, nz) || 1;
        lineas.push('vn ' + r6(nx / l) + ' ' + r6(ny / l) + ' ' + r6(nz / l));
      }
      var tuv = uvTextura(o);
      if (uv) for (i = 0; i < uv.count; i++) { var w = tuv(uv.getX(i), uv.getY(i)); lineas.push('vt ' + r6(w[0]) + ' ' + r6(w[1])); }

      var m = [].concat(o.material)[0];
      if (m && !mats.has(m)) {
        var id = 'mat' + mats.size;
        mats.set(m, id);
        mtl.push('newmtl ' + id);
        if (m.color) mtl.push('Kd ' + m.color.r + ' ' + m.color.g + ' ' + m.color.b);
        if (m.map && texs.has(m.map)) mtl.push('map_Kd ' + name + '-' + texs.get(m.map) + '.png');
        if (m.normalMap && texs.has(m.normalMap)) mtl.push('norm ' + name + '-' + texs.get(m.normalMap) + '.png');
        mtl.push('');
      }
      if (m) lineas.push('usemtl ' + mats.get(m));

      if (o.isPoints) {
        for (i = 0; i < p.count; i++) lineas.push('p ' + (base + i));
      } else {
        var f = k => { var v = base + k; return v + '/' + (uv ? v : '') + '/' + (no ? v : ''); };
        var total = idx ? idx.count : p.count;
        for (i = 0; i + 2 < total; i += 3) {
          var i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
          lineas.push('f ' + f(i0) + ' ' + f(i1) + ' ' + f(i2));
        }
      }
      base += p.count;
    });
    guardar(new Blob([lineas.join('\n')], { type: 'text/plain' }), name + '.obj');
    await pausa(300);
    guardar(new Blob([mtl.join('\n')], { type: 'text/plain' }), name + '.mtl');
    await bajarTexturas(list, name);
  }

  async function bajarTexturas(list, name) {
    for (var [t, k] of texturas(list)) {
      try {
        var b = await imagenPNG(t, !t.flipY);
        if (b) { await pausa(300); guardar(b, name + '-' + k + '.png'); }
      } catch (e) { console.warn('[tripo] textura', k, e); }
    }
  }

  // corre despues del frame de la app (rAF dentro de rAF), cuando el buffer todavia tiene la imagen
  function captura(name) {
    var c = canvasPrincipal();
    if (!c) return;
    window.dispatchEvent(new Event('resize'));
    requestAnimationFrame(() => requestAnimationFrame(() => c.toBlob(b => b && guardar(b, name + '-captura.png'))));
  }

  // dibuja solo esas piezas con la camara del visor y recorta su caja en pantalla.
  // Se lee el canvas en el mismo tick del render, antes de que el navegador borre el buffer.
  function foto(scene, list) {
    var c = S.cam && S.cam.get(scene);
    if (!c) return null;
    var r = c.renderer, cam = c.camera, solo = new Set(list), ocultos = [];
    scene.traverse(o => {
      if ((o.isMesh || o.isPoints || o.isLine || o.type === 'Sprite') && o.visible && !solo.has(o)) { o.visible = false; ocultos.push(o); }
    });
    var x0 = 1, y0 = 1, x1 = -1, y1 = -1, v = list[0].position.clone();
    list.forEach(o => {
      var g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      var b = g.boundingBox;
      for (var i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld).project(cam);
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      }
    });
    // el visor puede dejar puesto un render target, viewport o scissor (post-proceso, gizmo):
    // se dibuja a pantalla completa y despues se devuelve todo como estaba
    var rt = r.getRenderTarget(), tijera = r.getScissorTest(), out;
    try {
      var src = r.domElement, W = src.width, H = src.height;
      r.setRenderTarget(null);
      r.setScissorTest(false);
      r.setViewport(0, 0, W / r.getPixelRatio(), H / r.getPixelRatio());
      r.clear();
      r.render(scene, cam);
      var px = Math.max(0, (x0 + 1) / 2 * W - 8), py = Math.max(0, (1 - y1) / 2 * H - 8);
      var pw = Math.min(W, (x1 + 1) / 2 * W + 8) - px, ph = Math.min(H, (1 - y0) / 2 * H + 8) - py;
      if (!(pw > 4 && ph > 4)) { px = py = 0; pw = W; ph = H; }
      out = document.createElement('canvas');
      out.width = Math.round(pw); out.height = Math.round(ph);
      out.getContext('2d').drawImage(src, px, py, pw, ph, 0, 0, out.width, out.height);
    } finally {
      ocultos.forEach(o => { o.visible = true; });
      r.render(scene, cam);
      r.setRenderTarget(rt);
      r.setScissorTest(tijera);
      window.dispatchEvent(new Event('resize'));
    }
    var px1 = out.getContext('2d').getImageData(0, 0, out.width, out.height).data, lleno = false;
    for (var i = 3; i < px1.length && !lleno; i += 4 * 97) lleno = px1[i] && (px1[i - 1] || px1[i - 2] || px1[i - 3]);
    console.log('[tripo] foto', scene.uuid.slice(0, 8), list.length + ' piezas', W + 'x' + H, out.width + 'x' + out.height, lleno ? 'con imagen' : 'VACIA', rt ? 'habia render target' : '');
    return out;
  }

  // miniatura a la izquierda de la fila; al tocarla baja el PNG
  function conFoto(row, scene, list, name) {
    var c;
    try { c = foto(scene, list); } catch (e) { console.error('[tripo]', e); }
    var img = document.createElement('img');
    img.style.cssText = 'width:40px;height:40px;object-fit:contain;border-radius:6px;background:#0b0c0e;border:1px solid #2a2c31;flex:none';
    if (c) {
      img.src = c.toDataURL('image/png');
      img.title = 'Bajar PNG';
      img.style.cursor = 'pointer';
      img.onclick = () => c.toBlob(b => b && guardar(b, name + '.png'));
    } else img.style.visibility = 'hidden';
    row.prepend(img);
    return row;
  }

  // --- panel ---
  var btnCss = 'height:28px;padding:0 10px;border-radius:6px;border:1px solid #2a2c31;background:#1d1f23;color:inherit;cursor:pointer;font:inherit;font-size:12px;flex:none';
  var principalCss = ';background:#7c9cff;color:#0b0d14;border-color:#7c9cff;font-weight:600';

  function boton(label, fn, principal) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = btnCss + (principal ? principalCss : '');
    b.onclick = async () => {
      b.textContent = '...';
      try { await fn(t => { b.textContent = t; }); b.style.color = principal ? '#14532d' : '#4ade80'; }
      catch (e) { console.error('[tripo]', e); b.style.color = '#f87171'; b.title = e.message; }
      b.textContent = label;
    };
    return b;
  }

  function fila(texto, sub, ...botones) {
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #2a2c31';
    var t = document.createElement('div');
    t.style.cssText = 'flex:1;min-width:0';
    t.innerHTML = '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div><div style="color:#8b8d94;font-size:11px"></div>';
    t.children[0].textContent = texto;
    t.children[1].textContent = sub || '';
    d.append(t, ...botones);
    return d;
  }

  async function render() {
    document.getElementById('tripo-canvas')?.remove();
    var panel = document.createElement('div');
    panel.id = 'tripo-canvas';
    panel.style.cssText =
      'position:fixed;top:16px;right:16px;width:440px;max-height:85vh;overflow:auto;z-index:2147483647;pointer-events:auto;' +
      'background:#141518;color:#e8e8ea;border:1px solid #2a2c31;border-radius:12px;' +
      'font:13px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px #0008';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #2a2c31;position:sticky;top:0;background:#141518;z-index:1';
    var title = document.createElement('div');
    title.style.flex = '1';
    title.innerHTML = '<b>Leyendo el canvas...</b><div style="color:#8b8d94;font-size:11px">Si tarda, mueve el modelo con el mouse</div>';
    var cerrar = document.createElement('button');
    cerrar.textContent = 'x';
    cerrar.style.cssText = btnCss;
    cerrar.onclick = () => panel.remove();
    head.append(title, boton('Releer', render), cerrar);
    panel.append(head);
    // mismo truco que proyecto.js: que el modal de Tripo no se coma los clics
    ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'focusin'].forEach(t =>
      panel.addEventListener(t, e => e.stopPropagation()));
    var guard = () => {
      panel.removeAttribute('inert');
      panel.removeAttribute('aria-hidden');
      if (panel.style.pointerEvents !== 'auto') panel.style.pointerEvents = 'auto';
    };
    new MutationObserver(guard).observe(panel, { attributes: true, attributeFilter: ['inert', 'aria-hidden', 'style'] });
    document.documentElement.append(panel);

    // si el modelo todavia carga o el visor no dibujo en esa ventana, se reintenta solo (~30 s).
    // Las escenas de 3 vertices son el triangulo de pantalla completa del post-proceso
    var scenes = [];
    for (var intento = 0; intento < 12 && !scenes.length && panel.isConnected; intento++) {
      if (intento) title.querySelector('div').textContent = 'Esperando que el visor dibuje el modelo... (' + intento + ')';
      scenes = (await atrapar(1500))
        .map(s => ({ s, list: piezas(s) }))
        .filter(x => x.list.length && vertices(x.list) > 3)
        .sort((a, b) => vertices(b.list) - vertices(a.list));
    }
    // la camara se guarda en el frame siguiente al que encontro la escena
    if (scenes.some(x => !(S.cam && S.cam.has(x.s)))) {
      window.dispatchEvent(new Event('resize'));
      await pausa(400);
    }
    if (!scenes.length) {
      title.querySelector('b').textContent = 'No encontre ninguna escena';
      title.querySelector('div').textContent = 'Espera que termine de cargar, mueve el modelo y toca Releer';
      return;
    }

    var uuid = location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    var slug = (document.title.split(/[|\-–]/)[0] || '').toLowerCase().normalize('NFD').replace(/[^\w\s]/g, '').trim().replace(/\s+/g, '-');
    var name = (slug && slug !== 'tripo' ? slug : 'tripo') + (uuid ? '-' + uuid[0].slice(0, 8) : '');

    title.querySelector('b').textContent = scenes.length + (scenes.length > 1 ? ' escenas en pantalla' : ' escena en pantalla');
    title.querySelector('div').textContent = 'Nombre: ' + name;
    S.ultima = scenes;

    scenes.forEach(({ s, list }, n) => {
      var tag = scenes.length > 1 ? name + '-' + (n + 1) : name;
      var v = vertices(list), tx = texturas(list).size;
      var sub = list.length + ' piezas - ' + v.toLocaleString() + ' vertices - ' + tx + ' texturas';
      panel.append(conFoto(fila(n ? 'Escena ' + (n + 1) : 'Modelo en pantalla', sub,
        boton('GLB', av => glb(list, tag, av), true),
        boton('OBJ', () => obj(list, tag)),
        boton('Texturas', () => bajarTexturas(list, tag))), s, list, tag));
      list.forEach((o, i) => panel.append(conFoto(fila('  ' + (o.name || o.type + ' ' + i),
        o.geometry.attributes.position.count.toLocaleString() + ' vertices' + (o.isPoints ? ' - nube de puntos' : ''),
        boton('GLB', av => glb([o], tag + '-' + (o.name || i), av)),
        boton('OBJ', () => obj([o], tag + '-' + (o.name || i)))), s, [o], tag + '-' + (o.name || i))));
    });
    panel.append(fila('Captura del canvas', 'PNG de lo que se ve ahora', boton('PNG', async () => captura(name))));
  }

  render();
  console.log('[tripo] panel del canvas listo. Ultimas escenas en __tripoCanvas.ultima');
})();
