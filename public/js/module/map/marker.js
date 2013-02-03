/*global requirejs:true, require:true, define:true*/
/**
 * Модель карты
 */
define([
    'underscore', 'Browser', 'Utils', 'socket', 'Params', 'knockout', 'knockout.mapping', 'globalVM', 'leaflet'
], function (_, Browser, Utils, socket, P, ko, ko_mapping, globalVM, L) {
    'use strict';

    var cams2 = {cameras: {}, clusters: {}, groups: {}};

    function MarkerManager(map, options) {
        this.map = map;

        this.mapObjects = { photos: {}, clusters: {}, clustersLocal: {} };
        this.layerPhotos = L.layerGroup().addTo(this.map); // Слой фотографий
        this.layerClusters = L.layerGroup().addTo(this.map); // Слой кластеров
        this.layerClustersLocal = L.layerGroup().addTo(this.map); // Слой кластеров

        this.objects = {};
        this.objectsNew = {};

        this.pane = this.map._panes.markerPane;
        this.calcBound = null;
        this.currZoom = this.map.getZoom();
        this.refreshTimeout = null;
        this.refreshBind = this.refresh.bind(this, true);
        this.refreshingRequest = null;
        this.aggregateDelta = P.settings.CLUSTERING_ON_CLIENT_PIX_DELTA();

        this.animationOn = false;
        //Events
        this.map.on('zoomstart', this.onZoomStart, this);
        //this.map.on('zoomanim', this.onZoomAnim, this);
        this.map.on('moveend', this.onMapMoveEnd, this);

        this.reCalcBound();
    }

    /**
     * Обновляет границы области отображения маркеров.
     * Если расчитанная ранее область включает текущую, обновление не происходит.
     * @param {?boolean=} force Принудительный пересчет области. Например, при изменении масштаба в +, текущая область будет содержаться в предыдущей, тем не менее пересчет нужен.
     * @return {boolean} Флаг того, что границы изменились.
     */
    MarkerManager.prototype.reCalcBound = function (force) {
        if (force || !this.calcBound || !this.calcBound.contains(this.map.getBounds())) {
            this.calcBound = this.map.getBounds().pad(0.1);
            return true;
        } else {
            return false;
        }
    };

    /**
     * Вызывается по событию начала изменения масштаба карты
     */
    MarkerManager.prototype.onZoomStart = function (opt) {
        window.clearTimeout(this.refreshTimeout);
        if (!this.animationOn) {
            this.changeMarkersDisplayByType('none');
        }
    };

    /**
     * Вызывается по событию начала изменения масштаба карты с анимацией.
     * @param {!Object} opt Опции, которые передает API карты.
     */
    MarkerManager.prototype.onZoomAnim = function (opt) {
        var matchedMarkers,
            m;
        if (this.animationOn === true) {
            matchedMarkers = this.getMarkersByType(this.objects, ['cluster', 'cam', 'car']);
            for (m in matchedMarkers) {
                if (matchedMarkers.hasOwnProperty(m)) {
                    L.DomUtil.setPosition(matchedMarkers[m].dom, this.map._latLngToNewLayerPoint(matchedMarkers[m].point, opt.zoom, opt.center), false);
                }
            }
            this.changeMarkersDisplayByType('none', ['group']);
        }
    };

    /**
     * Вызывается по событию изменения базового слоя карты
     * Определяет, активна ли анимация изменения масштаба для данного слоя или нет
     */
    MarkerManager.prototype.layerChange = function () {
        if (this.map.options.zoomAnimation && this.map.options.markerZoomAnimation) {
            if (!this.animationOn) {
                this.pane.classList.add('neo-animate');
                this.animationOn = true;
            }
        } else if (this.animationOn) {
            this.pane.classList.remove('neo-animate');
            this.animationOn = false;
        }
    };

    /**
     * Вызывается по событию завершения движения карты - перемещения или изменения масштаба
     * При изменении масштаба отсрачиваем обновление данных, т.к. масштаб может меняться многократно за короткий промежуток времени
     */
    MarkerManager.prototype.onMapMoveEnd = function () {
        var NeedToRedraw = false;
        if (this.currZoom !== this.map.getZoom()) {
            window.clearTimeout(this.refreshTimeout);
            NeedToRedraw = this.reCalcBound(true);
            this.currZoom = this.map.getZoom();
            this.refreshTimeout = window.setTimeout(this.refreshBind, 400);
            return;
        } else {
            NeedToRedraw = this.reCalcBound();
        }
        if (NeedToRedraw) {
            this.refresh(false);
        }
    };

    /**
     * Обновление данных маркеров.
     * @param {?boolean=} reposExisting Пересчитывать позиции существующих маркеров. Например, при изменении масштаба надо пересчитывать.
     */
    MarkerManager.prototype.refresh = function (reposExisting) {
        this.startPendingAt = Date.now();

        socket.once('getBoundResult', function (data) {
            if (data && !data.error && this.startPendingAt === data.startAt) {
                this.processIncomingData(data); // Обрабатываем
                this.redraw(reposExisting); // Запускаем перерисовку
            } else {
                console.log('Ошибка загрузки новых камер: ' + data.message);
            }
            this.startPendingAt = null;
        }.bind(this));
        socket.emit('getBound', {z: this.currZoom, sw: Utils.geo.latlngToArr(this.calcBound.getSouthWest(), true), ne: Utils.geo.latlngToArr(this.calcBound.getNorthEast(), true), startAt: this.startPendingAt});
    };

    /**
     * Обрабатывает входящие данные
     */
    MarkerManager.prototype.processIncomingData = function (data) {
        var photos = {}, clusters = {}, clustersLocal = {}, curr,
            i, j;

        // Заполняем новый объект камер
        if (Array.isArray(data.photos) && data.photos.length > 0) {
            i = data.photos.length;
            while (i) { // while loop, reversed
                i--;
                photos[data.photos[i].id] = data.photos[i];
            }
        }

        /*
         var keysNew = _.pluck(data.photos, 'id'),
         keysExists = Object.keys(this.mapObjects.photos),
         toDel = _.difference(keysExists, keysNew),
         toAdd = _.difference(keysNew, keysExists);
         */
        // Проверяем, если такая фото уже есть в объекте mapObjects, удаляем её из нового объекта, а если такой фото в новом объекте нет, удаляем её и из старого
        // Удаляем принадлежность существующих фото локальному кластеру
        for (i in this.mapObjects.photos) {
            if (this.mapObjects.photos.hasOwnProperty(i)) {
                if (photos.hasOwnProperty(i)) {
                    delete photos[i];
                    delete this.mapObjects.photos[i].cluster;
                } else {
                    delete this.mapObjects.photos[i];
                }
            }
        }

        // Запускаем фабрику по новым камерам и сливаем их в основной объект камер mapObjects.photos
        //if (!Utils.isObjectEmpty(photos)) CamsFactory(cams, this.mapObjects.photos);
        _.assign(this.mapObjects.photos, photos);

        if (P.settings.CLUSTERING_ON_CLIENT()) {
            this.localClustering(this.mapObjects.photos);
        } else {
            for (i in this.mapObjects.photos) {
                if (this.mapObjects.photos.hasOwnProperty(i) && !this.mapObjects.photos[i].marker) {
                    curr = this.mapObjects.photos[i];
                    this.addMarker(
                        //curr.marker = new L.NeoMarker((curr.lat && curr.lng ? new L.LatLng(curr.lat, curr.lng) : mapDefCenter), {id: curr.id, type: 'cam', obj: curr, img: curr.icon})
                        curr.marker = L.marker((curr.lat && curr.lng ? new L.LatLng(curr.lat, curr.lng) : mapDefCenter), {riseOnHover: true, id: curr.id, type: 'photo', obj: curr, img: curr.icon})
                    );
                }
            }
        }

        // Заполняем новый объект групп
        // Создаем маркеры групп и добавляем их в текущий менеджер маркеров
        if (Array.isArray(data.clusters) && data.clusters.length > 0) {
            i = data.clusters.length;
            while (i) {
                i--;
                curr = data.clusters[i];
                this.addMarker(
                    curr.marker = new L.NeoMarker((curr.lat && curr.lng ? new L.LatLng(curr.lat, curr.lng) : mapDefCenter), {id: 'cl' + i, type: 'group', obj: curr, count: curr.count})
                );
                clusters[i] = curr;
            }
        }
        // Сливаем группы в основной объект груп this.mapObjects.clusters
        this.mapObjects.clusters = clusters;

        //Чистим ссылки
        delete data.photos;
        delete data.clusters;
        photos = clusters = clustersLocal = curr = data = null;
    };


    /**
     * Локальная кластеризация камер, пришедших клиенту. Проверяем на совпадение координат камер с учетом дельты. Связываем такие камеры
     */
    MarkerManager.prototype.localClustering = function (data) {
 /*       var deltaLAT = Math.abs(this.map.layerPointToLatLng(new L.Point(1, this.aggregateDelta)).lat - this.map.layerPointToLatLng(new L.Point(1, 0)).lat),
            deltaLNG = Math.abs(this.map.layerPointToLatLng(new L.Point(this.aggregateDelta, 1)).lng - this.map.layerPointToLatLng(new L.Point(0, 1)).lng),
            cutLAT = deltaLAT.toPrecision(1).length - 3,
            cutLNG = deltaLNG.toPrecision(1).length - 3,
            i,
            j,
            photo,
            currCoordId = '',
            cluster;
        for (i in data) {
            if (data.hasOwnProperty(i)) {
                photo = data[i];
                currCoordId = photo.geo[1].toFixed(cutLAT) + photo.geo[0].toFixed(cutLNG);
                if (!clusters[currCoordId]) {
                    clusters[currCoordId] = {lats: 0, lngs: 0, camsnum: 0, cams: {}};
                }
                cluster = clusters[currCoordId];
                cluster.cams[i] = photo;
                cluster.camsnum += 1;
                cluster.lats += photo.geo[1];
                cluster.lngs += photo.geo[0];
            }
        }
        this.mapObjects.clustersLocal = clusters;

        // Создаем маркеры фото и кластеров и добавляем их в текущий менеджер маркеров
        for (i in clusters) {
            if (!clusters.hasOwnProperty(i)) {
                cluster = clusters[i];
                curr = Utils.getObjectOneOwnProperty(cluster['cams']);
                if (cluster['camsnum'] > 1) {
                    for (j in cluster['cams']) {
                        if (cluster['cams'].hasOwnProperty(j)) {
                            cluster['cams'][j].cluster = i;
                        }
                    }
                    this.addMarker(
                        cluster.marker = new L.NeoMarker(new L.LatLng(cluster['lats'] / cluster['camsnum'], cluster['lngs'] / cluster['camsnum']), {id: 'p' + i, type: 'cluster', obj: cluster})
                    );
                } else if (!curr.marker) {
                    this.addMarker(
                        curr.marker = new L.NeoMarker((curr.lat && curr.lng ? new L.LatLng(curr.lat, curr.lng) : mapDefCenter), {id: curr.id, type: 'cam', obj: curr, img: curr.icon})
                    );
                }
            }
        }*/
    };

    /**
     * Перерисовывает маркеры. Влючает в себя обновление и репозиционирование маркеров
     * @param {?boolean=} reposExisting Пересчитывать позиции существующих маркеров. Например, при изменении масштаба надо пересчитывать
     */
    MarkerManager.prototype.redraw = function (reposExisting) {
        this.updateObjects(reposExisting);

        if (!this.animationOn) {
            this.changeMarkersDisplayByType('block', ['cam', 'car', 'cluster']);
        }
    };

    /**
     * Обновляет хэш отображаемых маркеров.
     * Удаляет ненужные и добавляет нужные (новые).
     *
     * @param {?boolean=} reposExisting Пересчитывать позиции существующих маркеров. Например, при изменении масштаба надо пересчитывать.
     * @param {?boolean=} searchRespectHash Учитывать хэш поиска.
     */
    MarkerManager.prototype.updateObjects = function (reposExisting, searchRespectHash) {
        var m, marker, markersAlreadyAdded = {}, respectHash = false, toDelete = true;

        if (!searchRespectHash && SearchInVM.open() && SearchInVM.applyMap && SearchInVM.applyMap() && SearchInVM.resultHash) {
            searchRespectHash = SearchInVM.resultHash;
        }
        respectHash = !!searchRespectHash;

        console.log('New objects: ' + Utils.getObjectPropertyLength(this.objectsNew) + ', current objects: ' + Utils.getObjectPropertyLength(this.objects));

        for (m in this.objects) {
            if (this.objects.hasOwnProperty(m)) {

                marker = this.objects[m];
                toDelete = true;

                switch (marker.type) {

                case 'cam':
                    if (respectHash) {
                        if (searchRespectHash[m]) {
                            toDelete = false;
                        }
                    }
                    else {
                        if (cams2.cameras[m] && !cams2.cameras[m].cluster) {
                            toDelete = false;
                        }
                    }
                    break;

                case 'car':
                    marker.dom.style.display = (Cars.visibleZooms.indexOf(this.currZoom) >= 0) ? 'block' : 'none';
                    toDelete = false;
                    break;
                }


                if (toDelete) {
                    Utils.Event.removeAll(marker.over);
                    marker.remove();
                    delete this.objects[m];
                }
                else {
                    if (reposExisting) {
                        marker.repos();
                    }
                }
            }
        }


        var fragment = document.createDocumentFragment();
        for (m in this.objectsNew) {
            if (this.objectsNew.hasOwnProperty(m)) {
                marker = this.objectsNew[m];

                if (marker.type === 'cam' && respectHash && !searchRespectHash[m]) {
                    continue;
                }
                if (marker.type === 'car' && marker.dom) {
                    marker.dom.style.display = (Cars.visibleZooms.indexOf(this.currZoom) >= 0) ? 'block' : 'none';
                }

                fragment.appendChild(marker.createDom());
                marker.repos();
                this.MarkerAddEvents(marker);
                this.objects[m] = marker;
                delete this.objectsNew[m];
            }
        }
        this.pane.appendChild(fragment);

        console.log('Still new (not added) objects: ' + Utils.getObjectPropertyLength(this.objectsNew) + ', current objects: ' + Utils.getObjectPropertyLength(this.objects));
        markersAlreadyAdded = m = fragment = null;
    };

    MarkerManager.prototype.addMarker = function (marker) {
        if (!this.objectsNew[marker.id]) {
            this.objectsNew[marker.id] = marker;
        }
    };

    MarkerManager.prototype.addMarkersAndRefreshThemImmediate = function (obj) {
        var searchRespectHash,
            respectHash;

        if (SearchInVM.open() && SearchInVM.applyMap && SearchInVM.applyMap() && SearchInVM.resultHash) {
            searchRespectHash = SearchInVM.resultHash;
        }
        respectHash = Boolean(searchRespectHash);


        var fragment = document.createDocumentFragment();
        var marker;
        for (var m in obj) {
            if (!obj.hasOwnProperty(m)) continue;
            marker = obj[m];
            this.objectsNew[marker.id] = marker;

            if (marker.type == 'cam' && cams[m]) {
                if ((respectHash && !searchRespectHash[m])) continue;
                if (!respectHash && !CheckMask(cams[m].mask, mask)) continue;
                if (!this.calcBound.contains(marker.point)) continue;
                if (!cams[m].zooms[this.currZoom]) continue;
            }

            fragment.appendChild(marker.createDom());
            this.MarkerAddEvents(marker);
            this.objects[m] = marker;
            delete this.objectsNew[marker.id];
        }
        this.pane.appendChild(fragment);

        console.log('Not added object: ' + Utils.getObjectPropertyLength(this.objectsNew) + ', now total objects is ' + Utils.getObjectPropertyLength(this.objects));
    };

    MarkerManager.prototype.MarkerAddEvents = function (marker) {
        Utils.Event.add(marker.over, 'touchstart', marker.TouchStart.bind(marker));
        Utils.Event.add(marker.over, 'touchend', marker.TouchEnd.bind(marker));
        Utils.Event.add(marker.over, 'click', marker.MarkerClick.bind(marker));
        Utils.Event.add(marker.over, 'mouseover', marker.MarkerOver.bind(marker));
        Utils.Event.add(marker.over, 'mouseout', marker.MarkerOut.bind(marker));
    };

    /**
     * Изменение свойства display маркеров указанных типов.
     * @param {!string} display Значение видимости
     * @param {?Array.<string>=} typeArray Массив типов
     */
    MarkerManager.prototype.changeMarkersDisplayByType = function (display, typeArray) {
        var matchedMarkers = typeArray ? this.getMarkersByType(this.objects, typeArray) : this.objects,
            m;
        for (m in matchedMarkers) {
            if (matchedMarkers.hasOwnProperty(m)) {
                matchedMarkers[m].dom.style.display = display;
            }
        }
        matchedMarkers = m = null;
    };

    /**
     * Репозиционирование маркеров
     * @param {?Array.<string>=} typeArray Массив типов
     */
    MarkerManager.prototype.reposByType = function (typeArray) {
        var matchedMarkers = typeArray ? this.getMarkersByType(this.objects, typeArray) : this.objects,
            m;
        for (m in matchedMarkers) {
            if (matchedMarkers.hasOwnProperty(m)) {
                matchedMarkers[m].repos();
            }
        }
        matchedMarkers = m = null;
    };

    /**
     * Возвращает из заданного хеша маркеров хэш маркеров с указанными типами
     * @param {!Object} objects Хэш маркеров
     * @param {!Array.<string>} typeArray Массив типов
     * @return {Object}
     */
    MarkerManager.prototype.getMarkersByType = function (objects, typeArray) {
        typeArray.sort();
        return _.filter(objects, function (marker) {
            return _.indexOf(typeArray, marker.type, true) >= 0;
        });
    };

    return MarkerManager;
});