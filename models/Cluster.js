import { Schema } from 'mongoose';
import { registerModel } from '../controllers/connection';

export let Cluster = null;
export let ClusterParams = null;

const ClusterPoster = {
    cid: { type: Number },
    geo: { type: [Number] },
    file: { type: String },
    dir: { type: String },
    title: { type: String },
    year: { type: Number },
    year2: { type: Number }
};

const ClusterSchema = new Schema(
    {
        g: { type: [Number] }, // Cluster left top corner coordinates (indexed)
        z: { type: Number }, // Cluster zoom (indexed)

        geo: { type: [Number] }, // Cluster center of gravity coordinates
        c: { type: Number }, // Number of photos inside cluster
        y: { type: Schema.Types.Mixed }, // Hash (object kye:value) of years within cluster
        p: ClusterPoster // Cluster poster
    },
    { strict: true }
);

ClusterSchema.index({ g: '2d', z: 1 });

const ClusterParamsSchema = new Schema(
    {
        z: { type: Number, index: { unique: true } }, // Cluster zoom
        w: { type: Number }, // Cluster width in degrees
        h: { type: Number }, // Cluster height in degrees

        // Эти поля общие для всех параметров, так что такой документ в коллекции будет один
        // Next fields are common for all parameter, so such document is single
        sgeo: { type: [Number] }, // [lng, lat] of base cluster
        sz: { type: Number }, // Zoom, on which we calculated clusters
        sw: { type: Number }, // Cluster width in pixels
        sh: { type: Number }, // Cluster hight in pixels
        gravity: { type: Boolean }
    },
    { strict: true }
);

registerModel(db => {
    Cluster = db.model('Cluster', ClusterSchema);
    ClusterParams = db.model('ClusterParams', ClusterParamsSchema);
});
